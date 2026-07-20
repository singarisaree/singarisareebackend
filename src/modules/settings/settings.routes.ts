import { Router, Response } from 'express';
import { settingsService } from './settings.service';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/validate';
import { sendSuccess } from '@/shared/api-response';
import { uploadSingle } from '@/middleware/upload';
import { ApiError } from '@/shared/api-response';
import { Request } from 'express';
import { z } from 'zod';
import { validateBody } from '@/middleware/validate';
import { templateKindParamSchema, whatsappTemplateDraftSchema } from './whatsapp-template.schema';
import { whatsAppService } from '@/integrations/whatsapp.service';
const router = Router();

router.get(
  '/public',
  asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const settings = await settingsService.getPublicSettings();
    sendSuccess(res, settings, 'Public settings fetched');
  }),
);

router.get(
  '/whatsapp-templates',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const templates = await settingsService.getWhatsAppTemplates(true);
    sendSuccess(res, templates, 'WhatsApp templates fetched');
  }),
);

router.put(
  '/whatsapp-templates/:kind',
  authenticateAdmin,
  loadAdmin,
  validateBody(whatsappTemplateDraftSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { kind } = templateKindParamSchema.parse(req.params);
    const template = await settingsService.saveWhatsAppTemplateDraft(kind, req.body);
    sendSuccess(res, template, 'WhatsApp template draft saved');
  }),
);

router.post(
  '/whatsapp-templates/:kind/sample-image',
  authenticateAdmin,
  loadAdmin,
  uploadSingle,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { kind } = templateKindParamSchema.parse(req.params);
    if (!req.file) throw new ApiError(400, 'No sample image provided');
    const template = await whatsAppService.uploadTemplateSample(kind, req.file);
    sendSuccess(res, template, 'Template sample image uploaded');
  }),
);

router.post(
  '/whatsapp-templates/:kind/submit',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { kind } = templateKindParamSchema.parse(req.params);
    const template = await whatsAppService.submitTemplate(kind);
    sendSuccess(res, template, 'Template submitted to Meta');
  }),
);

router.post(
  '/whatsapp-templates/:kind/sync',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { kind } = templateKindParamSchema.parse(req.params);
    const template = await whatsAppService.syncTemplateStatus(kind);
    sendSuccess(res, template, 'Template status refreshed');
  }),
);

router.patch(
  '/whatsapp-templates/:kind/active',
  authenticateAdmin,
  loadAdmin,
  validateBody(z.object({ isActive: z.boolean() })),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { kind } = templateKindParamSchema.parse(req.params);
    const template = await settingsService.setWhatsAppTemplateActive(kind, req.body.isActive);
    sendSuccess(res, template, template.isActive ? 'Template activated' : 'Template deactivated');
  }),
);

router.get(
  '/',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const settings = await settingsService.getAll(req.query.group as string);
    sendSuccess(res, settings, 'Settings fetched');
  }),
);

router.put(
  '/',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { settings } = req.body as {
      settings: Array<{ key: string; value: unknown; group?: string }>;
    };
    const results = await Promise.all(
      settings.map((s) => settingsService.upsert(s.key, s.value, s.group)),
    );
    sendSuccess(res, results, 'Settings updated');
  }),
);

router.get(
  '/our-story/image',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const image = await settingsService.getOurStoryImage();
    sendSuccess(res, image, 'Our Story image fetched');
  }),
);

router.post(
  '/our-story/image',
  authenticateAdmin,
  loadAdmin,
  uploadSingle,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) throw new ApiError(400, 'No image provided');
    const image = await settingsService.uploadOurStoryImage(req.file);
    sendSuccess(res, image, 'Our Story image updated');
  }),
);

router.delete(
  '/our-story/image',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const image = await settingsService.deleteOurStoryImage();
    sendSuccess(res, image, 'Our Story image deleted');
  }),
);

router.get(
  '/signature',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const signature = await settingsService.getInvoiceSignature();
    sendSuccess(res, signature, 'Invoice signature fetched');
  }),
);

router.put(
  '/signature',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dataUrl } = req.body as { dataUrl: string };
    if (!dataUrl) throw new ApiError(400, 'Signature data is required');
    const signature = await settingsService.saveInvoiceSignature(dataUrl);
    sendSuccess(res, signature, 'Invoice signature saved');
  }),
);

router.delete(
  '/signature',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const signature = await settingsService.deleteInvoiceSignature();
    sendSuccess(res, signature, 'Invoice signature deleted');
  }),
);

export default router;
