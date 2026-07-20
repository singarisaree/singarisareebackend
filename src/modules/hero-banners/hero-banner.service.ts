import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';

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

  async create(data: {
    title?: string;
    subtitle?: string;
    linkUrl?: string;
    sortOrder?: number;
    isActive?: boolean;
    startsAt?: string;
    endsAt?: string;
  }, file: Express.Multer.File, mobileFile?: Express.Multer.File) {
    const upload = await localStorageService.uploadImage(file.buffer, 'hero-banners');
    let mobileUpload;
    if (mobileFile) {
      mobileUpload = await localStorageService.uploadImage(mobileFile.buffer, 'hero-banners/mobile');
    }

    return prisma.heroBanner.create({
      data: {
        ...data,
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

    const updateData: Record<string, unknown> = {
      title: data.title as string | undefined,
      subtitle: data.subtitle as string | undefined,
      linkUrl: data.linkUrl as string | undefined,
      sortOrder: data.sortOrder as number | undefined,
      isActive: data.isActive as boolean | undefined,
    };
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
