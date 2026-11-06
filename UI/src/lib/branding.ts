import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type Branding = { businessName: string | null; logo: string | null };

const KEY = ['branding'] as const;

/** Public, so the login page and the Clock-in Screen can show it too. */
export const useBranding = () => useQuery({ queryKey: KEY, queryFn: () => api<Branding>('/branding'), staleTime: 300_000 });

export function useSaveBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Branding) => api('/branding', { method: 'PUT', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

const LOGO_SIZE = 256;
const MAX_DATA_URL = 250_000;

/** Shrinks a picked image in the browser; a small logo fits in the database. */
export async function shrinkLogo(file: File): Promise<string> {
  const image = await createImageBitmap(file);
  const scale = Math.min(1, LOGO_SIZE / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = canvas.toDataURL('image/png');
  return png.length <= MAX_DATA_URL ? png : canvas.toDataURL('image/webp', 0.85);
}
