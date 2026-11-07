import { describe, expect, it } from 'vitest';
import { svgProblem } from './branding';

describe('SVG logos', () => {
  it('accepts a plain drawing, with gradients and embedded images', () => {
    expect(svgProblem('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="5" fill="url(#a)"/></svg>')).toBeNull();
    expect(svgProblem('<?xml version="1.0"?>\n<svg width="10"><use href="#a"/><image xlink:href="data:image/png;base64,AAAA"/></svg>')).toBeNull();
  });

  it('refuses what is not an SVG', () => {
    expect(svgProblem('<html></html>')).toContain('not an SVG');
  });

  it.each([
    '<svg><script>alert(1)</script></svg>',
    '<svg><SCRIPT src="x"/></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><a href="javascript:alert(1)"/></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<!DOCTYPE svg [<!ENTITY a "b">]><svg></svg>',
  ])('refuses active content: %s', (svg) => {
    expect(svgProblem(svg)).toContain('scripts');
  });

  it('refuses links to outside files', () => {
    expect(svgProblem('<svg><image href="https://example.com/a.png"/></svg>')).toContain('outside');
  });
});
