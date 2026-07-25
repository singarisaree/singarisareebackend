import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';

const HEX_COLOR = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

function normalizeOptionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function normalizeColor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const color = String(value).trim();
  if (!HEX_COLOR.test(color)) {
    throw new ApiError(400, 'Text color must be a valid hex color (e.g. #7a0012)');
  }
  return color;
}

export class HeroBannerService {
  async findActive() {
    const now = new Date();
    return prisma.heroBanner.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [
          { startsAt: null, endsAt: null },
          { startsAt: { lte: now }, endsAt: null },
          { startsAt: null, endsAt: { gte: now } },
          { startsAt: { lte: now }, endsAt: { gte: now } },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findAll() {
    return prisma.heroBanner.findMany({
      where: { deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async create(
    data: {
      brandText?: string | null;
      title?: string | null;
      subtitle?: string | null;
      brandColor?: string | null;
      titleColor?: string | null;
      subtitleColor?: string | null;
      linkUrl?: string | null;
      sortOrder?: number;
      isActive?: boolean;
      startsAt?: string;
      endsAt?: string;
    },
    file: Express.Multer.File,
    mobileFile?: Express.Multer.File,
  ) {
    const upload = await localStorageService.uploadImage(file.buffer, 'hero-banners');
    let mobileUpload;
    if (mobileFile) {
      mobileUpload = await localStorageService.uploadImage(mobileFile.buffer, 'hero-banners/mobile');
    }

    return prisma.heroBanner.create({
      data: {
        brandText: normalizeOptionalText(data.brandText) ?? null,
        title: normalizeOptionalText(data.title) ?? null,
        subtitle: normalizeOptionalText(data.subtitle) ?? null,
        brandColor: normalizeColor(data.brandColor) ?? null,
        titleColor: normalizeColor(data.titleColor) ?? null,
        subtitleColor: normalizeColor(data.subtitleColor) ?? null,
        linkUrl: normalizeOptionalText(data.linkUrl) ?? null,
        sortOrder: data.sortOrder ?? 0,
        isActive: data.isActive !== false,
        imageUrl: upload.url,
        publicId: upload.publicId,
        mobileImageUrl: mobileUpload?.url,
        mobilePublicId: mobileUpload?.publicId,
        startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
        endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
      },
    });
  }

  async update(id: string, data: Record<string, unknown>) {
    const banner = await prisma.heroBanner.findFirst({ where: { id, deletedAt: null } });
    if (!banner) throw new ApiError(404, 'Banner not found');

    const updateData: Record<string, unknown> = {};

    if ('brandText' in data) updateData.brandText = normalizeOptionalText(data.brandText) ?? null;
    if ('title' in data) updateData.title = normalizeOptionalText(data.title) ?? null;
    if ('subtitle' in data) updateData.subtitle = normalizeOptionalText(data.subtitle) ?? null;
    if ('brandColor' in data) updateData.brandColor = normalizeColor(data.brandColor) ?? null;
    if ('titleColor' in data) updateData.titleColor = normalizeColor(data.titleColor) ?? null;
    if ('subtitleColor' in data) {
      updateData.subtitleColor = normalizeColor(data.subtitleColor) ?? null;
    }
    if ('linkUrl' in data) updateData.linkUrl = normalizeOptionalText(data.linkUrl) ?? null;
    if ('sortOrder' in data && data.sortOrder !== undefined && data.sortOrder !== null) {
      updateData.sortOrder = Number(data.sortOrder);
    }
    if ('isActive' in data && data.isActive !== undefined) {
      updateData.isActive = Boolean(data.isActive);
    }
    if (data.startsAt) updateData.startsAt = new Date(data.startsAt as string);
    if (data.endsAt) updateData.endsAt = new Date(data.endsAt as string);

    return prisma.heroBanner.update({
      where: { id },
      data: updateData as Parameters<typeof prisma.heroBanner.update>[0]['data'],
    });
  }

  async reorder(orderedIds: string[]) {
    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.heroBanner.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
  }

  async softDelete(id: string) {
    const banner = await prisma.heroBanner.findFirst({ where: { id, deletedAt: null } });
    if (!banner) throw new ApiError(404, 'Banner not found');

    await localStorageService.deleteImage(banner.publicId);
    if (banner.mobilePublicId) await localStorageService.deleteImage(banner.mobilePublicId);

    await prisma.heroBanner.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }
}

export const heroBannerService = new HeroBannerService();
