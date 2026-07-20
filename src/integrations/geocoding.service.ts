import { logger } from '@/utils/logger';

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

interface ShippingAddressInput {
  country: string;
  state: string;
  city: string;
  postalCode: string;
  addressLine1: string;
  addressLine2?: string;
  landmark?: string;
  latitude?: number;
  longitude?: number;
}

export class GeocodingService {
  resolveCoordinatesForCheckout(address: ShippingAddressInput): ShippingAddressInput {
    if (this.hasValidCoordinates(address.latitude, address.longitude)) {
      return {
        ...address,
        latitude: address.latitude,
        longitude: address.longitude,
      };
    }
    return address;
  }

  async resolveCoordinates(address: ShippingAddressInput): Promise<ShippingAddressInput> {
    if (this.hasValidCoordinates(address.latitude, address.longitude)) {
      return {
        ...address,
        latitude: address.latitude,
        longitude: address.longitude,
      };
    }

    const coords = await this.forwardGeocode(address);
    if (!coords) return address;

    return {
      ...address,
      latitude: coords.latitude,
      longitude: coords.longitude,
    };
  }

  private hasValidCoordinates(latitude?: number, longitude?: number): boolean {
    if (latitude == null || longitude == null) return false;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  }

  private async forwardGeocode(address: ShippingAddressInput): Promise<GeoCoordinates | null> {
    const query = [
      address.addressLine1,
      address.addressLine2,
      address.landmark,
      address.city,
      address.state,
      address.postalCode,
      address.country,
    ]
      .filter(Boolean)
      .join(', ');

    if (!query.trim()) return null;

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`,
        {
          headers: {
            'Accept-Language': 'en',
            'User-Agent': 'SingariSarees/1.0 (order-geocoding)',
          },
        },
      );
      if (!response.ok) return null;

      const results = (await response.json()) as Array<{ lat: string; lon: string }>;
      const match = results[0];
      if (!match) return null;

      const latitude = Number(match.lat);
      const longitude = Number(match.lon);
      if (!this.hasValidCoordinates(latitude, longitude)) return null;

      return { latitude, longitude };
    } catch (error) {
      logger.warn('Shipping address geocoding failed', { error });
      return null;
    }
  }
}

export const geocodingService = new GeocodingService();
