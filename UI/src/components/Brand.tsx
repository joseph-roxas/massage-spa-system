import { useEffect } from 'react';
import { useBranding } from '../lib/branding';

/** The logo and business name with "Spa System" beneath; just "Spa System" until they are set. */
export function BrandMark({ center = false }: { center?: boolean }) {
  const { data } = useBranding();
  return (
    <div className={`flex items-center gap-3 ${center ? 'justify-center' : ''}`}>
      {data?.logo && <img src={data.logo} alt="" className="h-10 w-10 shrink-0 rounded object-contain" />}
      <div className="min-w-0">
        {data?.businessName && <p className="truncate text-sm font-semibold text-stone-800">{data.businessName}</p>}
        <p className={`font-semibold uppercase tracking-widest text-teal-700 ${data?.businessName ? 'text-xs' : 'text-sm'}`}>Spa System</p>
      </div>
    </div>
  );
}

/** Keeps the browser tab's title and icon on the business's name and logo. */
export function BrandingEffect() {
  const { data } = useBranding();
  useEffect(() => {
    if (data?.businessName) document.title = data.businessName;
    if (!data?.logo) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = data.logo;
  }, [data]);
  return null;
}
