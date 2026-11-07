import { useEffect } from 'react';
import { useBranding } from '../lib/branding';

/** The logo and business name with "Spa System" beneath; just "Spa System" until they are set. `stacked` puts the logo above the name; `large` is for a screen read from a distance. */
export function BrandMark({ center = false, stacked = false, large = false }: { center?: boolean; stacked?: boolean; large?: boolean }) {
  const { data } = useBranding();
  const layout = stacked ? `flex-col gap-2 ${center ? 'items-center text-center' : 'items-start'}` : `items-center gap-3 ${center ? 'justify-center' : ''}`;
  const size = large ? 'h-24 w-24' : stacked ? 'h-14 w-14' : 'h-10 w-10';
  return (
    <div className={`flex ${layout}`}>
      {data?.logo && <img src={data.logo} alt="" className={`${size} shrink-0 rounded object-contain`} />}
      <div className={stacked ? 'w-full min-w-0' : 'min-w-0'}>
        {data?.businessName && <p className={`truncate font-semibold text-stone-800 ${large ? 'text-2xl' : 'text-sm'}`}>{data.businessName}</p>}
        <p className={`font-semibold uppercase tracking-widest text-teal-700 ${large ? 'text-sm' : data?.businessName ? 'text-xs' : 'text-sm'}`}>Spa System</p>
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
