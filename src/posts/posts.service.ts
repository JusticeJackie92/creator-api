import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { CreatePostDto, CommentDto } from './dto/post.dto';
import { buildCursorQuery, toCursorPage } from '../common/utils/pagination.util';
import { ContentAccess, PostStatus } from '@prisma/client';

const HASHTAG_RE = /#([\p{L}\p{N}_]{2,50})/gu;

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  async create(authorId: string, dto: CreatePostDto) {
    if (!dto.body && (!dto.mediaIds || dto.mediaIds.length === 0)) {
      throw new BadRequestException('Post needs text or media');
    }
    if (dto.access === ContentAccess.PAY_PER_VIEW && !dto.priceCents) {
      throw new BadRequestException('priceCents required for pay-per-view');
    }

    // Ownership check on every attached media (no attaching others' assets)
    if (dto.mediaIds?.length) {
      const owned = await this.prisma.media.count({
        where: { id: { in: dto.mediaIds }, ownerId: authorId, status: 'READY', deletedAt: null },
      });
      if (owned !== dto.mediaIds.length) throw new ForbiddenException('One or more media items are invalid');
    }

    const hashtags = Array.from(new Set([...(dto.body ?? '').matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase()))).slice(0, 20);

    let status: PostStatus = PostStatus.PUBLISHED;
    let scheduledAt: Date | null = null;
    if (dto.draft) status = PostStatus.DRAFT;
    else if (dto.scheduledAt) {
      scheduledAt = new Date(dto.scheduledAt);
      if (scheduledAt <= new Date()) throw new BadRequestException('scheduledAt must be in the future');
      status = PostStatus.SCHEDULED;
    }

    return this.prisma.post.create({
      data: {
        authorId,
        body: dto.body,
        access: dto.access ?? ContentAccess.FREE,
        priceCents: dto.access === ContentAccess.PAY_PER_VIEW ? dto.priceCents : null,
        status,
        scheduledAt,
        hashtags,
        media: dto.mediaIds?.length
          ? { create: dto.mediaIds.map((mediaId, position) => ({ mediaId, position })) }
          : undefined,
      },
      include: { media: true },
    });
  }

  /**
   * Creator page feed with access gating: locked posts return metadata and a
   * `locked: true` flag but NEVER media references or full body — entitlement
   * is enforced server-side, not by client-side blurring.
   */
  async creatorFeed(viewerId: string, creatorUserId: string, cursor?: string, take = 20) {
    const rows = await this.prisma.post.findMany({
      where: { authorId: creatorUserId, status: 'PUBLISHED', deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      include: { media: { include: { media: true }, orderBy: { position: 'asc' } } },
      ...buildCursorQuery(cursor, take),
    });
    const page = toCursorPage(rows, take);
    const items = await this.shapeAndDecorate(viewerId, page.items);
    return { items, nextCursor: page.nextCursor };
  }

  /**
   * Home timeline: published posts from creators the viewer actively
   * subscribes to, plus the viewer's own posts, newest first. Same
   * server-side gating and author decoration as the creator feed.
   */
  async homeFeed(viewerId: string, cursor?: string, take = 20) {
    const subs = await this.prisma.subscription.findMany({
      where: { subscriberId: viewerId, status: { in: ['ACTIVE', 'TRIALING'] }, currentPeriodEnd: { gt: new Date() } },
      select: { creatorUserId: true },
    });
    const authorIds = Array.from(new Set([viewerId, ...subs.map((s) => s.creatorUserId)]));

    const rows = await this.prisma.post.findMany({
      where: { authorId: { in: authorIds }, status: 'PUBLISHED', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { media: { include: { media: true }, orderBy: { position: 'asc' } } },
      ...buildCursorQuery(cursor, take),
    });
    const page = toCursorPage(rows, take);
    const items = await this.shapeAndDecorate(viewerId, page.items);
    return { items, nextCursor: page.nextCursor };
  }

  /**
   * The viewer's saved posts (Collections), gated + decorated the same way.
   * Bookmark uses a composite key, so we page by post id: resolve the ordered
   * list of bookmarked post ids, slice a window, then hydrate + shape.
   */
  async bookmarksFeed(viewerId: string, cursor?: string, take = 20) {
    const marks = await this.prisma.bookmark.findMany({
      where: { userId: viewerId },
      orderBy: { createdAt: 'desc' },
      select: { postId: true },
    });
    const orderedIds = marks.map((m) => m.postId);
    if (orderedIds.length === 0) return { items: [], nextCursor: null };

    let start = 0;
    if (cursor) {
      const idx = orderedIds.indexOf(cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const pageIds = orderedIds.slice(start, start + take);
    const nextCursor = start + take < orderedIds.length ? pageIds[pageIds.length - 1] : null;

    const posts = await this.prisma.post.findMany({
      where: { id: { in: pageIds }, status: 'PUBLISHED', deletedAt: null },
      include: { media: { include: { media: true }, orderBy: { position: 'asc' } } },
    });
    const byId = new Map(posts.map((p) => [p.id, p]));
    const ordered = pageIds.map((id) => byId.get(id)).filter(Boolean) as any[];
    const items = await this.shapeAndDecorate(viewerId, ordered);
    return { items, nextCursor };
  }

  /**
   * Shared shaping: applies entitlement gating (locked posts leak no media or
   * gated body) and decorates each post with its author's mini-profile plus
   * the viewer's like/bookmark flags — all in a fixed number of queries.
   */
  private async shapeAndDecorate(viewerId: string, posts: any[]) {
    if (posts.length === 0) return [];
    const authorIds = Array.from(new Set(posts.map((p) => p.authorId)));
    const postIds = posts.map((p) => p.id);

    const [profiles, liked, bookmarked] = await Promise.all([
      this.prisma.profile.findMany({
        where: { userId: { in: authorIds } },
        select: {
          userId: true, username: true, displayName: true, avatarMediaId: true,
          user: { select: { creator: { select: { verifiedBadge: true } } } },
        },
      }),
      this.prisma.like.findMany({ where: { userId: viewerId, postId: { in: postIds } }, select: { postId: true } }),
      this.prisma.bookmark.findMany({ where: { userId: viewerId, postId: { in: postIds } }, select: { postId: true } }),
    ]);

    const authorMap = new Map(
      profiles.map((p) => [
        p.userId,
        { username: p.username, displayName: p.displayName, avatarMediaId: p.avatarMediaId, verified: p.user.creator?.verifiedBadge ?? false },
      ]),
    );
    const likedSet = new Set(liked.map((l) => l.postId));
    const bookmarkedSet = new Set(bookmarked.map((b) => b.postId));

    return Promise.all(
      posts.map(async (post) => {
        const entitled = await this.isEntitledToPost(viewerId, post);
        const author = authorMap.get(post.authorId) ?? null;
        const flags = { author, likedByMe: likedSet.has(post.id), bookmarkedByMe: bookmarkedSet.has(post.id) };

        if (entitled) {
          return {
            id: post.id, authorId: post.authorId, body: post.body, access: post.access, priceCents: post.priceCents,
            createdAt: post.createdAt, pinned: post.pinned, likeCount: post.likeCount, commentCount: post.commentCount,
            locked: false,
            media: post.media.map((pm: any) => ({ id: pm.media.id, type: pm.media.type, width: pm.media.width, height: pm.media.height })),
            ...flags,
          };
        }
        return {
          id: post.id, authorId: post.authorId, access: post.access, priceCents: post.priceCents,
          createdAt: post.createdAt, pinned: post.pinned, likeCount: post.likeCount, commentCount: post.commentCount,
          locked: true, mediaCount: post.media.length,
          body: post.access === 'FREE' ? post.body : null,
          ...flags,
        };
      }),
    );
  }

  private async isEntitledToPost(viewerId: string, post: { authorId: string; access: ContentAccess; id: string }) {
    if (post.authorId === viewerId) return true;
    if (post.access === 'FREE') return true;
    if (post.access === 'SUBSCRIBERS') {
      const sub = await this.prisma.subscription.findFirst({
        where: {
          subscriberId: viewerId, creatorUserId: post.authorId,
          status: { in: ['ACTIVE', 'TRIALING'] }, currentPeriodEnd: { gt: new Date() },
        },
      });
      return !!sub;
    }
    const purchase = await this.prisma.purchase.findFirst({ where: { buyerId: viewerId, postId: post.id } });
    return !!purchase;
  }

  async like(userId: string, postId: string) {
    await this.assertVisible(postId);
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.like.createMany({ data: [{ userId, postId }], skipDuplicates: true });
      if (created.count > 0) {
        await tx.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } });
      }
    });
    return { message: 'Liked' };
  }

  async unlike(userId: string, postId: string) {
    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.like.deleteMany({ where: { userId, postId } });
      if (deleted.count > 0) {
        await tx.post.update({ where: { id: postId }, data: { likeCount: { decrement: 1 } } });
      }
    });
    return { message: 'Unliked' };
  }

  async bookmark(userId: string, postId: string) {
    await this.assertVisible(postId);
    await this.prisma.bookmark.createMany({ data: [{ userId, postId }], skipDuplicates: true });
    return { message: 'Bookmarked' };
  }

  async unbookmark(userId: string, postId: string) {
    await this.prisma.bookmark.deleteMany({ where: { userId, postId } });
    return { message: 'Removed bookmark' };
  }

  async comment(userId: string, postId: string, dto: CommentDto) {
    const post = await this.assertVisible(postId);
    // Only entitled viewers may comment on gated posts
    const entitled = await this.isEntitledToPost(userId, post);
    if (!entitled) throw new ForbiddenException('Subscribe or purchase to comment');

    const [comment] = await this.prisma.$transaction([
      this.prisma.comment.create({ data: { postId, authorId: userId, body: dto.body, parentId: dto.parentId ?? null } }),
      this.prisma.post.update({ where: { id: postId }, data: { commentCount: { increment: 1 } } }),
    ]);
    return comment;
  }

  async comments(postId: string, cursor?: string, take = 20) {
    const rows = await this.prisma.comment.findMany({
      where: { postId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { profile: { select: { username: true, displayName: true, avatarMediaId: true } } } } },
      ...buildCursorQuery(cursor, take),
    });
    return toCursorPage(rows, take);
  }

  async pin(userId: string, postId: string, pinned: boolean) {
    const res = await this.prisma.post.updateMany({ where: { id: postId, authorId: userId }, data: { pinned } });
    if (res.count === 0) throw new NotFoundException('Post not found');
    return { message: pinned ? 'Pinned' : 'Unpinned' };
  }

  async remove(userId: string, postId: string) {
    const res = await this.prisma.post.updateMany({
      where: { id: postId, authorId: userId, deletedAt: null },
      data: { deletedAt: new Date(), status: 'DELETED' },
    });
    if (res.count === 0) throw new NotFoundException('Post not found');
    return { message: 'Deleted' };
  }

  private async assertVisible(postId: string) {
    const post = await this.prisma.post.findFirst({ where: { id: postId, status: 'PUBLISHED', deletedAt: null } });
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }
}
