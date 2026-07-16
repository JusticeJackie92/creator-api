import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ConfirmUploadDto, CreateFolderDto, UpdateMediaAccessDto } from './dto/media.dto';
import { buildCursorQuery, toCursorPage } from '../common/utils/pagination.util';
import { ContentAccess, MediaStatus, MediaType } from '@prisma/client';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;   // 25 MB
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const ALLOWED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'];
const ALLOWED_VIDEO_FORMATS = ['mp4', 'mov', 'webm', 'mkv'];
const CONTENT_TYPE_BY_FORMAT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
};

const SIGN_UPLOAD_TTL_SECONDS = 10 * 60;   // 10 min to complete the PUT
const DELIVERY_URL_TTL_SECONDS = 60 * 60;  // 1 hour signed GET

/**
 * Direct signed upload flow — the storage credentials NEVER leave the server
 * and files NEVER pass through our API:
 *
 *   1. Client asks POST /media/sign          -> server picks the object key
 *      (scoped to `users/{userId}/...`, never client-controlled) and returns
 *      a presigned PUT URL valid for 10 minutes.
 *   2. Client uploads the file straight to Storj (S3-compatible) with that URL.
 *   3. Client calls POST /media/confirm with the returned key.
 *   4. Server INDEPENDENTLY verifies the object via a HEAD request (never
 *      trusting client-supplied metadata), validates format/size, and only
 *      then persists the media row.
 *
 * A `virusScanHook()` seam is provided for wiring an AV/moderation pipeline.
 */
@Injectable()
export class MediaService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly prisma: PrismaService) {
    this.bucket = process.env.STORJ_BUCKET as string;
    this.s3 = new S3Client({
      endpoint: process.env.STORJ_ENDPOINT || 'https://gateway.storjshare.io',
      region: process.env.STORJ_REGION || 'us-1',
      credentials: {
        accessKeyId: process.env.STORJ_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.STORJ_SECRET_ACCESS_KEY as string,
      },
      // Storj's S3-compatible gateway expects path-style addressing.
      forcePathStyle: true,
    });
  }

  // ---------------------------------------------------------- sign

  async signUpload(userId: string, resourceType: 'image' | 'video', filename?: string) {
    const ext = this.extractExtension(filename, resourceType);
    const key = `users/${userId}/${randomUUID()}.${ext}`;
    const contentType = CONTENT_TYPE_BY_FORMAT[ext] ?? (resourceType === 'image' ? 'image/jpeg' : 'video/mp4');

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: SIGN_UPLOAD_TTL_SECONDS });

    return {
      uploadUrl,
      method: 'PUT' as const,
      key,
      contentType,
      resourceType,
      expiresIn: SIGN_UPLOAD_TTL_SECONDS,
    };
  }

  private extractExtension(filename: string | undefined, resourceType: 'image' | 'video'): string {
    const fallback = resourceType === 'image' ? 'jpg' : 'mp4';
    if (!filename) return fallback;
    const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
    const ext = match?.[1]?.toLowerCase();
    if (!ext) return fallback;
    const allowed = resourceType === 'image' ? ALLOWED_IMAGE_FORMATS : ALLOWED_VIDEO_FORMATS;
    return allowed.includes(ext) ? ext : fallback;
  }

  // ---------------------------------------------------------- confirm

  async confirmUpload(userId: string, dto: ConfirmUploadDto) {
    // The regex in the DTO already constrains shape; enforce ownership too.
    if (!dto.key.startsWith(`users/${userId}/`)) {
      throw new ForbiddenException('key does not belong to your folder');
    }

    const existing = await this.prisma.media.findUnique({ where: { publicId: dto.key } });
    if (existing) return existing; // idempotent confirm

    // Server-side verification via HEAD request — never trust client metadata.
    let head: any;
    try {
      head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: dto.key }));
    } catch {
      throw new BadRequestException('Asset not found on storage. Upload may have failed.');
    }

    const format = (dto.key.split('.').pop() || '').toLowerCase();
    const bytes = Number(head.ContentLength ?? 0);

    if (dto.resourceType === 'image') {
      if (!ALLOWED_IMAGE_FORMATS.includes(format)) throw new BadRequestException('Unsupported image format');
      if (bytes > MAX_IMAGE_BYTES) throw new BadRequestException('Image exceeds size limit');
    } else {
      if (!ALLOWED_VIDEO_FORMATS.includes(format)) throw new BadRequestException('Unsupported video format');
      if (bytes > MAX_VIDEO_BYTES) throw new BadRequestException('Video exceeds size limit');
    }

    await this.virusScanHook(dto.key, dto.resourceType);

    return this.prisma.media.create({
      data: {
        ownerId: userId,
        type: dto.resourceType === 'image' ? MediaType.IMAGE : MediaType.VIDEO,
        status: MediaStatus.READY,
        publicId: dto.key,
        resourceType: dto.resourceType,
        format,
        width: null,
        height: null,
        duration: null,
        bytes,
      },
    });
  }

  /** Seam for AV / content-moderation pipeline. */
  private async virusScanHook(_key: string, _resourceType: string): Promise<void> {
    // Intentionally a no-op here. In production, enqueue a BullMQ job that
    // runs moderation/AV and flips Media.status READY only after it passes.
    return;
  }

  // ---------------------------------------------------------- vault

  async createFolder(userId: string, dto: CreateFolderDto) {
    if (dto.parentId) {
      const parent = await this.prisma.vaultFolder.findFirst({ where: { id: dto.parentId, ownerId: userId } });
      if (!parent) throw new BadRequestException('Parent folder not found');
    }
    return this.prisma.vaultFolder.create({
      data: { ownerId: userId, name: dto.name, parentId: dto.parentId ?? null },
    });
  }

  async listVault(userId: string, folderId?: string, cursor?: string, take = 20) {
    const rows = await this.prisma.media.findMany({
      where: { ownerId: userId, folderId: folderId ?? null, deletedAt: null, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      ...buildCursorQuery(cursor, take),
    });
    const [folders, page] = [
      await this.prisma.vaultFolder.findMany({ where: { ownerId: userId, parentId: folderId ?? null } }),
      toCursorPage(rows, take),
    ];
    return { folders, ...page };
  }

  async moveToFolder(userId: string, mediaId: string, folderId: string | null) {
    if (folderId) {
      const folder = await this.prisma.vaultFolder.findFirst({ where: { id: folderId, ownerId: userId } });
      if (!folder) throw new BadRequestException('Folder not found');
    }
    const res = await this.prisma.media.updateMany({
      where: { id: mediaId, ownerId: userId },
      data: { folderId },
    });
    if (res.count === 0) throw new NotFoundException('Media not found');
    return { message: 'Moved' };
  }

  async updateAccess(userId: string, mediaId: string, dto: UpdateMediaAccessDto) {
    if (dto.access === ContentAccess.PAY_PER_VIEW && !dto.priceCents) {
      throw new BadRequestException('priceCents required for pay-per-view');
    }
    const res = await this.prisma.media.updateMany({
      where: { id: mediaId, ownerId: userId },
      data: { access: dto.access, priceCents: dto.access === ContentAccess.PAY_PER_VIEW ? dto.priceCents : null },
    });
    if (res.count === 0) throw new NotFoundException('Media not found');
    return { message: 'Updated' };
  }

  /** Soft delete (trash). A cleanup job purges the Storj object later. */
  async trash(userId: string, mediaId: string) {
    const res = await this.prisma.media.updateMany({
      where: { id: mediaId, ownerId: userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Media not found');
    return { message: 'Moved to trash' };
  }

  // ---------------------------------------------------------- delivery (access-gated URLs)

  /**
   * Returns a delivery URL ONLY if the viewer is entitled:
   * owner, free content, active subscriber, or purchaser.
   * All delivery goes through short-lived presigned GET URLs, so the bucket
   * itself never needs to be public and raw keys can't be guessed or reused.
   */
  async getDeliveryUrl(viewerId: string, mediaId: string) {
    const media = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!media || media.deletedAt || media.status !== 'READY') throw new NotFoundException();

    const entitled = await this.isEntitled(viewerId, media.ownerId, media.access, media.id);
    if (!entitled) throw new ForbiddenException('Content locked');

    return {
      url: await this.signedUrl(media.publicId),
      type: media.type,
      width: media.width,
      height: media.height,
      duration: media.duration,
    };
  }

  /**
   * Lock-aware metadata for a single media item. Unlike getDeliveryUrl this
   * never throws on locked content — it returns the lock state, price, and
   * (only if the viewer is entitled) a signed URL. Used to render chat/vault
   * tiles where a fan must see "Unlock for $X" before paying.
   */
  async getMediaMeta(viewerId: string, mediaId: string) {
    const media = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!media || media.deletedAt || media.status !== 'READY') throw new NotFoundException();

    const entitled = await this.isEntitled(viewerId, media.ownerId, media.access, media.id);
    return {
      id: media.id,
      type: media.type,
      access: media.access,
      priceCents: media.priceCents,
      ownerId: media.ownerId,
      locked: !entitled,
      url: entitled ? await this.signedUrl(media.publicId) : null,
      width: media.width,
      height: media.height,
      duration: media.duration,
    };
  }

  /** Public delivery for FREE media only (avatars, banners, free posts) — still a short-lived signed URL. */
  async getPublicUrl(mediaId: string) {
    const media = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!media || media.deletedAt || media.status !== 'READY') throw new NotFoundException();
    if (media.access !== 'FREE') throw new ForbiddenException('Content locked');
    return { url: await this.signedUrl(media.publicId), type: media.type, width: media.width, height: media.height };
  }

  private async signedUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.s3, command, { expiresIn: DELIVERY_URL_TTL_SECONDS });
  }

  async isEntitled(viewerId: string, ownerId: string, access: ContentAccess, mediaId: string): Promise<boolean> {
    if (viewerId === ownerId) return true;
    if (access === ContentAccess.FREE) return true;

    if (access === ContentAccess.SUBSCRIBERS) {
      const sub = await this.prisma.subscription.findFirst({
        where: {
          subscriberId: viewerId, creatorUserId: ownerId,
          status: { in: ['ACTIVE', 'TRIALING'] }, currentPeriodEnd: { gt: new Date() },
        },
      });
      return !!sub;
    }

    // PAY_PER_VIEW
    const purchase = await this.prisma.purchase.findFirst({ where: { buyerId: viewerId, mediaId } });
    return !!purchase;
  }
}
