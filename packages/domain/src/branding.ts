const ACTIVE = /<\s*(script|foreignObject|iframe|embed|object|audio|video)\b|<!(DOCTYPE|ENTITY)|\son\w+\s*=|javascript:/i;
const OUTSIDE = /\b(?:xlink:)?href\s*=\s*["']?\s*(?!#|data:image\/)[^\s"'>]/i;

/**
 * Why an SVG can't be the logo, or null. A logo only ever shows as an image, where
 * a browser won't run anything inside it; this keeps out what doesn't belong in
 * one anyway, since it is served to everyone, the login page included.
 */
export function svgProblem(svg: string): string | null {
  if (!/<svg[\s>]/i.test(svg)) return 'That file is not an SVG image.';
  if (ACTIVE.test(svg)) return 'That SVG has scripts or embedded content. Export it again as a plain image.';
  if (OUTSIDE.test(svg)) return 'That SVG links to files outside itself. Export it again with everything embedded.';
  return null;
}
