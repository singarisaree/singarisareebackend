import { PrismaClient, CouponType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Singari Sarees database...');

  const passwordHash = await bcrypt.hash('Singari@Admin2024', 12);

  const admin = await prisma.admin.upsert({
    where: { email: 'admin@singarisarees.com' },
    update: {},
    create: {
      email: 'admin@singarisarees.com',
      passwordHash,
      name: 'Singari Admin',
      role: 'super_admin',
    },
  });
  console.log('✅ Admin created:', admin.email);

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
  console.log('✅ Settings seeded');

  const categories = [
    { name: 'Banarasi Silk', slug: 'banarasi-silk', description: 'Exquisite handwoven Banarasi silk sarees with intricate zari work', sortOrder: 1 },
    { name: 'Kanjivaram', slug: 'kanjivaram', description: 'Traditional Kanjivaram silk sarees from Tamil Nadu', sortOrder: 2 },
    { name: 'Chanderi', slug: 'chanderi', description: 'Lightweight Chanderi sarees with delicate motifs', sortOrder: 3 },
    { name: 'Organza', slug: 'organza', description: 'Ethereal organza sarees perfect for celebrations', sortOrder: 4 },
    { name: 'Cotton Handloom', slug: 'cotton-handloom', description: 'Breathable handloom cotton sarees for everyday elegance', sortOrder: 5 },
  ];

  const createdCategories = [];
  for (const cat of categories) {
    const category = await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {},
      create: { ...cat, isActive: true },
    });
    createdCategories.push(category);
  }
  console.log('✅ Categories seeded');

  const products = [
    {
      name: 'Royal Banarasi Red Silk Saree',
      slug: 'royal-banarasi-red-silk-saree',
      sku: '84729103',
      categoryId: createdCategories[0].id,
      description: 'A magnificent Banarasi silk saree featuring intricate gold zari brocade work on a rich crimson base. Handwoven by master artisans in Varanasi, this saree embodies centuries of weaving tradition.',
      fabric: 'Pure Banarasi Silk with Gold Zari',
      care: 'Dry clean only. Store in a muslin cloth. Avoid direct sunlight.',
      price: 24999,
      mrp: 34999,
      discount: 28.57,
      baseSoldCount: 125,
      tags: ['banarasi', 'silk', 'wedding', 'bridal'],
      colors: [
        { name: 'Crimson Red', hexCode: '#8B0000', stock: 15 },
        { name: 'Maroon', hexCode: '#800000', stock: 12 },
      ],
    },
    {
      name: 'Temple Border Kanjivaram',
      slug: 'temple-border-kanjivaram',
      sku: '47293018',
      categoryId: createdCategories[1].id,
      description: 'Authentic Kanjivaram silk saree with traditional temple border design. The contrasting pallu features intricate peacock motifs woven in pure gold zari.',
      fabric: 'Pure Kanjivaram Silk',
      care: 'Dry clean recommended. Iron on low heat.',
      price: 18999,
      mrp: 25999,
      discount: 26.92,
      baseSoldCount: 458,
      tags: ['kanjivaram', 'silk', 'temple', 'traditional'],
      colors: [
        { name: 'Royal Blue', hexCode: '#002366', stock: 20 },
        { name: 'Emerald Green', hexCode: '#046307', stock: 18 },
        { name: 'Purple', hexCode: '#4B0082', stock: 10 },
      ],
    },
    {
      name: 'Chanderi Gold Butta Saree',
      slug: 'chanderi-gold-butta-saree',
      sku: '61938407',
      categoryId: createdCategories[2].id,
      description: 'Delicate Chanderi cotton silk saree adorned with gold butta motifs. Lightweight and breathable, perfect for summer weddings and festive occasions.',
      fabric: 'Chanderi Cotton Silk',
      care: 'Gentle hand wash or dry clean.',
      price: 8999,
      mrp: 12999,
      discount: 30.77,
      baseSoldCount: 312,
      tags: ['chanderi', 'lightweight', 'summer'],
      colors: [
        { name: 'Ivory', hexCode: '#FFFFF0', stock: 25 },
        { name: 'Peach', hexCode: '#FFDAB9', stock: 20 },
      ],
    },
    {
      name: 'Organza Embroidered Festive Saree',
      slug: 'organza-embroidered-festive-saree',
      sku: '30572841',
      categoryId: createdCategories[3].id,
      description: 'Stunning organza saree with hand-embroidered floral patterns. The sheer fabric creates an ethereal look perfect for evening celebrations.',
      fabric: 'Pure Organza with Embroidery',
      care: 'Dry clean only.',
      price: 12999,
      mrp: 17999,
      discount: 27.78,
      baseSoldCount: 187,
      tags: ['organza', 'embroidered', 'festive'],
      colors: [
        { name: 'Blush Pink', hexCode: '#FFB6C1', stock: 15 },
        { name: 'Mint Green', hexCode: '#98FF98', stock: 12 },
        { name: 'Lavender', hexCode: '#E6E6FA', stock: 8 },
      ],
    },
    {
      name: 'Handloom Cotton Jamdani',
      slug: 'handloom-cotton-jamdani',
      sku: '92810456',
      categoryId: createdCategories[4].id,
      description: 'Traditional Jamdani handloom cotton saree with geometric patterns. Woven on traditional looms by skilled artisans.',
      fabric: 'Pure Handloom Cotton',
      care: 'Machine wash gentle cycle. Line dry.',
      price: 4999,
      mrp: 6999,
      discount: 28.57,
      baseSoldCount: 987,
      tags: ['cotton', 'handloom', 'jamdani', 'everyday'],
      colors: [
        { name: 'Natural White', hexCode: '#FAF0E6', stock: 30 },
        { name: 'Indigo', hexCode: '#3F00FF', stock: 22 },
        { name: 'Mustard', hexCode: '#FFDB58', stock: 18 },
      ],
    },
  ];

  for (const productData of products) {
    const { colors, ...data } = productData;
    const existing = await prisma.product.findUnique({ where: { slug: data.slug } });
    if (existing) continue;

    const product = await prisma.product.create({ data: { ...data, isActive: true, isFeatured: true } });

    for (const [index, color] of colors.entries()) {
      const productColor = await prisma.productColor.create({
        data: {
          productId: product.id,
          name: color.name,
          hexCode: color.hexCode,
          sortOrder: index,
        },
      });

      await prisma.inventory.create({
        data: {
          productId: product.id,
          productColorId: productColor.id,
          quantity: color.stock,
        },
      });
    }
  }
  console.log('✅ Products seeded');

  const coupons = [
    { code: 'WELCOME10', type: CouponType.PERCENTAGE, value: 10, minOrderAmount: 5000, maxDiscount: 2000, usageLimit: 100 },
    { code: 'FLAT500', type: CouponType.FLAT, value: 500, minOrderAmount: 10000, usageLimit: 50 },
    { code: 'SINGARI15', type: CouponType.PERCENTAGE, value: 15, minOrderAmount: 15000, maxDiscount: 5000, usageLimit: 25 },
  ];

  for (const coupon of coupons) {
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      update: {},
      create: { ...coupon, isActive: true },
    });
  }
  console.log('✅ Coupons seeded');

  const reviews = [
    { customerName: 'Priya Sharma', rating: 5, comment: 'Absolutely stunning Banarasi saree! The quality exceeded my expectations. Perfect for my wedding.' },
    { customerName: 'Ananya Reddy', rating: 5, comment: 'The Kanjivaram saree is a masterpiece. Authentic craftsmanship and beautiful packaging.' },
    { customerName: 'Meera Patel', rating: 4, comment: 'Lovely Chanderi saree, very lightweight and elegant. Delivery was prompt.' },
    { customerName: 'Kavitha Nair', rating: 5, comment: 'Singari Sarees never disappoints. This is my third purchase and each one has been exceptional.' },
    { customerName: 'Deepa Iyer', rating: 5, comment: 'The organza saree was perfect for my daughter\'s reception. Received so many compliments!' },
  ];

  for (const [index, review] of reviews.entries()) {
    await prisma.customerReview.create({
      data: { ...review, isActive: true, sortOrder: index },
    });
  }
  console.log('✅ Reviews seeded');

  console.log('🎉 Seeding completed successfully!');
  console.log('\n📧 Admin Login: admin@singarisarees.com');
  console.log('🔑 Admin Password: Singari@Admin2024');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
