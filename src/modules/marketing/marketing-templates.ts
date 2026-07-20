export interface MarketingTemplate {
  key: string;
  name: string;
  description: string;
  heading: string;
  story: string;
}

export const MARKETING_TEMPLATES: MarketingTemplate[] = [
  {
    key: 'new-collection',
    name: 'New Collection',
    description: 'Announce fresh saree arrivals',
    heading: '✨ New Collection at Singari Sarees',
    story:
      'We just launched exquisite new sarees curated for every occasion. Explore silk, cotton, and festive weaves — limited pieces available.',
  },
  {
    key: 'coupon-offer',
    name: 'Coupon & Offer',
    description: 'Share a discount or special offer',
    heading: '🎁 Exclusive Offer Just for You',
    story:
      'Use our latest coupon at checkout and save on your favourite sarees. Hurry — offer valid for a limited time only!',
  },
  {
    key: 'festival-sale',
    name: 'Festival Sale',
    description: 'Festival / seasonal promotion',
    heading: '🪔 Festival Sale — Up to 50% Off',
    story:
      'Celebrate in style with handpicked sarees at special festival prices. Free shipping on qualifying orders. Shop before stocks run out!',
  },
  {
    key: 'restock-alert',
    name: 'Back in Stock',
    description: 'Notify when popular items return',
    heading: '🔔 Your Favourites Are Back',
    story:
      'Good news! Best-selling colours and weaves are back in stock. Grab yours before they sell out again.',
  },
  {
    key: 'welcome',
    name: 'Welcome Message',
    description: 'Warm welcome for new customers',
    heading: '🙏 Welcome to Singari Sarees',
    story:
      'Thank you for being part of our family. Discover timeless sarees crafted with love — we are here to help you find the perfect drape.',
  },
  {
    key: 'custom',
    name: 'Custom Message',
    description: 'Write your own heading and story',
    heading: '',
    story: '',
  },
];

export function renderMarketingMessage(
  heading: string,
  story: string,
  customerName: string,
): string {
  const name = customerName.trim() || 'there';
  const replaceName = (text: string) => text.replace(/\{\{name\}\}/gi, name);

  const lines = [
    `*${replaceName(heading.trim())}*`,
    '',
    `Hi ${name},`,
    '',
    replaceName(story.trim()),
    '',
    '— Team Singari Sarees',
    'singarisarees.com',
  ];

  return lines.join('\n');
}
