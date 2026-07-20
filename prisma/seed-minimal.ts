import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/** Fresh production DB: admin + store settings only (no sample products). */
async function main() {
  const email = process.env.ADMIN_EMAIL || 'singarisaree@gmail.com';
  const password = process.env.ADMIN_PASSWORD || 'Singari@143';
  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.admin.upsert({
    where: { email },
    update: { passwordHash, name: 'Singari Admin', role: 'super_admin', isActive: true },
    create: {
      email,
      passwordHash,
      name: 'Singari Admin',
      role: 'super_admin',
    },
  });
  console.log('Admin ready:', admin.email);

  const settings = [
    { key: 'store_name', value: 'Singari Sarees', group: 'general' },
    { key: 'store_tagline', value: 'Timeless Elegance, Woven with Love', group: 'general' },
    { key: 'store_email', value: 'singarisaree@gmail.com', group: 'contact' },
    { key: 'store_phone', value: '+91 94904 58789', group: 'contact' },
    { key: 'store_address', value: 'Flat No. 306, Floor 3, Sumadhura Prestige Apartments, Doctors Colony, Road No. 6, Hyderabad - 500035', group: 'contact' },
    { key: 'instagram_url', value: 'https://instagram.com/singarisarees', group: 'social' },
    { key: 'facebook_url', value: 'https://facebook.com/singarisarees', group: 'social' },
    { key: 'whatsapp_number', value: '+919490458789', group: 'social' },
    { key: 'default_shipping_charge', value: 99, group: 'shipping' },
    { key: 'free_shipping_threshold', value: 1999, group: 'shipping' },
    { key: 'free_shipping_enabled', value: false, group: 'shipping' },
    { key: 'estimated_delivery_days', value: 7, group: 'shipping' },
    { key: 'announcement_bar_enabled', value: true, group: 'announcement' },
    { key: 'announcement_bar_text', value: 'FREE SHIPPING on Orders Above Rs. 1999', group: 'announcement' },
    { key: 'announcement_bar_secondary_text', value: '', group: 'announcement' },
  ];

  for (const setting of settings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: { value: setting.value },
      create: setting,
    });
  }
  console.log('Settings seeded');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
