// ─── Icon ──────────────────────────────────────────────────────────────────────
// Imports lucide icons as React components — NOT as DOM-mutating UMD calls.
// The prototype loaded lucide via UMD and rendered via React.createElement on
// raw tuples, which works but blurs the layer between "library output" and
// "our DOM". The lucide-react package gives us properly-typed components and
// removes the need to look up the global `window.lucide`.
//
// This component is intentionally a thin facade so the rest of the codebase
// can keep saying `<Icon name="play" />` without caring how the underlying
// library exposes its glyphs.

import type { ComponentType, SVGProps } from 'react';
import { icons, type LucideProps } from 'lucide-react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: string;
  className?: string;
  strokeWidth?: number;
}

// Convert kebab-case (the names we use in code) to PascalCase (lucide-react keys).
function toPascal(name: string): string {
  return name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

export function Icon({ name, className = '', strokeWidth = 2, ...rest }: IconProps) {
  const key = toPascal(name);
  const Cmp = (icons as Record<string, ComponentType<LucideProps>>)[key];
  if (!Cmp) {
    // Render a placeholder square rather than crashing — keeps layout stable
    // if a typo or version drift breaks an icon name.
    return (
      <svg
        className={className}
        width="1em"
        height="1em"
        viewBox="0 0 24 24"
        aria-hidden="true"
        {...rest}
      />
    );
  }
  return <Cmp className={className} strokeWidth={strokeWidth} aria-hidden="true" {...rest} />;
}
