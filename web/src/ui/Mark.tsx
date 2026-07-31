// The Ferrum mark.
//
// The app is named after iron, so the mark is iron's tile from the periodic table: atomic number 26
// in the corner, the symbol Fe filling the square. It reads as a logo at 20px and as a real thing at
// 200px, and it needs no wordmark beside it to say what it is.
//
// Drawn rather than imported, so it inherits the theme instead of shipping two PNGs. The identical
// shape is in `web/public/favicon.svg` for the browser tab — the only place it cannot be a
// component. If one changes, change both.

interface Props {
  size?: number;
  /** Filled brand tile (the app bar) versus an outlined one (on a coloured surface). */
  variant?: "solid" | "outline";
  className?: string;
}

export function Mark({ size = 22, variant = "solid", className }: Props) {
  const solid = variant === "solid";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Ferrum"
    >
      <rect
        x={solid ? 0 : 0.9}
        y={solid ? 0 : 0.9}
        width={solid ? 32 : 30.2}
        height={solid ? 32 : 30.2}
        rx="5"
        fill={solid ? "var(--primary)" : "none"}
        stroke={solid ? "none" : "currentColor"}
        strokeWidth="1.8"
      />
      {/* The atomic number, small and in the corner exactly as a real tile prints it. */}
      <text
        x="5.5"
        y="10.5"
        fill={solid ? "var(--on-primary)" : "currentColor"}
        fillOpacity="0.72"
        fontSize="8"
        fontWeight="500"
        fontFamily="var(--font-mono, ui-monospace, monospace)"
      >
        26
      </text>
      <text
        x="16"
        y="26"
        textAnchor="middle"
        fill={solid ? "var(--on-primary)" : "currentColor"}
        fontSize="17"
        fontWeight="600"
        letterSpacing="-0.5"
        fontFamily="var(--font-ui, system-ui, sans-serif)"
      >
        Fe
      </text>
    </svg>
  );
}
