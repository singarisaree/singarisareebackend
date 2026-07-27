import multer from 'multer';
import { ApiError } from '@/shared/api-response';

const storage = multer.memoryStorage();

const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only JPEG, PNG, and WebP images are allowed') as unknown as null, false);
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 6,
  },
});

export const uploadSingle = upload.single('image');
export const uploadMultiple = upload.array('images', 6);
export const uploadReturnImages = upload.array('images', 3);

/** Product + variants save: up to 6 images × many variants in one request */
export const uploadAdminProductSave = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 36,
  },
}).any();

const videoFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const mime = (file.mimetype || '').toLowerCase();
  const name = file.originalname || '';
  const allowedMime =
    mime === 'video/mp4' ||
    mime === 'video/webm' ||
    mime === 'video/quicktime' ||
    mime === 'video/mov' ||
    mime === 'video/x-m4v' ||
    mime === 'video/x-msvideo' ||
    // Browsers sometimes omit type or use octet-stream for MOV/WebM
    ((mime === '' || mime === 'application/octet-stream') &&
      /\.(mp4|webm|mov|m4v)$/i.test(name));

  if (allowedMime || /\.(mp4|webm|mov|m4v)$/i.test(name)) {
    cb(null, true);
  } else {
    cb(
      new ApiError(400, 'Only MP4, WebM, or MOV videos are allowed') as unknown as null,
      false,
    );
  }
};

/** Homepage Instagram reel upload (converted/compressed server-side). */
export const uploadInstagramReelVideo = multer({
  storage,
  fileFilter: videoFilter,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1,
  },
}).single('video');
