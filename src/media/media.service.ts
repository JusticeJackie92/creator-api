import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../prisma/prisma.service';
import { ConfirmUploadDto, CreateFolderDto, UpdateMediaAccessDto } from './dto/media.dto';
import { buildCursorQuery, toCursorPage } from '../common/utils/pagination.util';
import { ContentAccess, MediaStatus, MediaType } from '@prisma/client';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;   // 25 MB
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const ALLOWED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'];
const ALLOWED_VIDEO_FORMATS = ['mp4', 'mov', 'webm', 'mkv'];

/**
 * Direct signed upload flow — the API secret NEVER leaves the server and
 * files NEVER pass through our API:
 *
 *   1. Client asks POST /media/sign          -> server returns a signature
 *      scoped to folder `users/{userId}` with a 10-min timestamp window.
 *   2. Client uploads the file straight to Cloudinary with that signature.
 *   3. Client calls POST /media/confirm with the returned public_id.
 *   4. Server INDEPENDENTLY verifies the asset via Cloudinary's Admin API
 *      (never trusting client-supplied metadata), validates format/size,
 *      and only then persists the media row.
 *
 * A `virusScanHook()` seam is provided for wiring an AV/moderation pipeline.
 */
@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  // ---------------------------------------------------------- sign

  signUpload(userId: string, resourceType: 'image' | 'video') {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `users/${userId}`;

    // Signature binds folder + timestamp; the client cannot upload outside
    // their own folder or reuse the signature after Cloudinary's window.
    const paramsToSign: Record<string, string | number> = { timestamp, folder };
    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET as string,
    );

    return {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY, // public identifier, not a secret
      timestamp,
      folder,
      signature,
      resourceType,
      uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
    };
  }

  // ---------------------------------------------------------- confirm

  async confirmUpload(userId: string, dto: ConfirmUploadDto) {
    // The regex in the DTO already constrains shape; enforce ownership too.
    if (!dto.publicId.startsWith(`users/${userId}/`)) {
      throw new ForbiddenException('public_id does not belong to your folder');
    }

    const existing = await this.prisma.media.findUnique({ where: { publicId: dto.publicId } });
    if (existing) return existing; // idempotent confirm

    // Server-side verification via Admin API — never trust client metadata.
    let asset: any;
    try {
      asset = await cloudinary.api.resource(dto.publicId, { resource_type: dto.resourceType });
    } catch {
      throw new BadRequestException('Asset not found on storage. Upload may have failed.');
    }

    const format = String(asset.format ?? '').toLowerCase();
    const bytes = Number(asset.bytes ?? 0);

    if (dto.resourceType === 'image') {
      if (!ALLOWED_IMAGE_FORMATS.includes(format)) throw new BadRequestException('Unsupported image format');
      if (bytes > MAX_IMAGE_BYTES) throw new BadRequestException('Image exceeds size limit');
    } else {
      if (!ALLOWED_VIDEO_FORMATS.includes(format)) throw new BadRequestException('Unsupported video format');
      if (bytes > MAX_VIDEO_BYTES) throw new BadRequestException('Video exceeds size limit');
    }

    await this.virusScanHook(dto.publicId, dto.resourceType);

    return this.prisma.media.create({
      data: {
        ownerId: userId,
        type: dto.resourceType === 'image' ? MediaType.IMAGE : MediaType.VIDEO,
        status: MediaStatus.READY,
        publicId: asset.public_id,
        resourceType: asset.resource_type,
        format,
        width: asset.width ?? null,
        height: asset.height ?? null,
        duration: asset.duration ?? null,
        bytes,
      },
    });
  }

  /** Seam for AV / content-moderation pipeline (e.g. Cloudinary moderation add-ons). */
  private async virusScanHook(_publicId: string, _resourceType: string): Promise<void> {
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

  /** Soft delete (trash). A cleanup job purges Cloudinary assets later. */
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
   * Signed/authenticated delivery should be enabled on the Cloudinary
   * account so raw URLs cannot be guessed.
   */
  async getDeliveryUrl(viewerId: string, mediaId: string) {
    const media = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!media || media.deletedAt || media.status !== 'READY') throw new NotFoundException();

    const entitled = await this.isEntitled(viewerId, media.ownerId, media.access, media.id);
    if (!entitled) throw new ForbiddenException('Content locked');

    return { url: this.signedUrl(media), type: media.type, width: media.width, height: media.height, duration: media.duration };
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
      url: entitled ? this.signedUrl(media) : null,
      width: media.width,
      height: media.height,
      duration: media.duration,
    };
  }

  /**
   * Builds a delivery URL. Access is enforced at the API layer (this is only
   * ever called for an entitled viewer), so we deliver the asset with the same
   * delivery type it was uploaded as (Cloudinary's default `upload`), secure.
   *
   * Production hardening: upload assets as `type: 'authenticated'` (add it to
   * the signed params in signUpload and to the client upload form), then switch
   * this back to `type: 'authenticated', sign_url: true` so the CDN itself
   * refuses un-signed requests. With plain `upload` delivery, anyone holding
   * the (random, unguessable) URL can view it — fine for dev, not for PPV at scale.
   */
  private signedUrl(media: { publicId: string; resourceType: string; type: string }) {
    return cloudinary.url(media.publicId, {
      resource_type: media.resourceType,
      secure: true,
      transformation: media.type === 'IMAGE' ? [{ quality: 'auto', fetch_format: 'auto' }] : undefined,
    });
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
