import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { svgProblem } from '@spa/domain';
import { api } from './api';

export type Branding = { businessName: string | null; logo: string | null };
export type BrandingDetails = { tin: string | null; address: string | null };

const KEY = ['branding'] as const;

/** Public, so the login page and the Clock-in Screen can show it too. */
export const useBranding = () => useQuery({ queryKey: KEY, queryFn: () => api<Branding>('/branding'), staleTime: 300_000 });

export function useSaveBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Branding & BrandingDetails) => api('/branding', { method: 'PUT', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export const useBrandingDetails = () => useQuery({ queryKey: [...KEY, 'details'], queryFn: () => api<BrandingDetails>('/branding/details') });

const LOGO_SIZE = 256;
const MAX_DATA_URL = 250_000;

/** An SVG stays as it is, sharp at any size, so it is checked rather than shrunk. */
async function svgLogo(file: File): Promise<string> {
  const text = await file.text();
  const problem = svgProblem(text);
  if (problem) throw new Error(problem);
  const url = `data:image/svg+xml;base64,${btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''))}`;
  if (url.length > MAX_DATA_URL) throw new Error('That SVG is too large. Export it again without embedded images.');
  return url;
}

export const isSvg = (file: File) => file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');

/** Readies a picked image in the browser; a small logo fits in the database. */
export async function shrinkLogo(file: File): Promise<string> {
  if (isSvg(file)) return svgLogo(file);
  const image = await createImageBitmap(file);
  const scale = Math.min(1, LOGO_SIZE / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = canvas.toDataURL('image/png');
  return png.length <= MAX_DATA_URL ? png : canvas.toDataURL('image/webp', 0.85);
}
