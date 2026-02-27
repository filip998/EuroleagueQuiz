/**
 * EuroLeague Quiz Logo
 * Full version: basketball icon + text (for home screen)
 * Mini version: icon only (for in-game top-left)
 */
export function LogoFull({ className = "" }) {
  return (
    <div className={`flex flex-col items-center ${className}`}>
      <LogoIcon size={96} />
      <div className="mt-3 text-center">
        <div
          className="font-display text-5xl sm:text-6xl tracking-wide text-elq-dark leading-none flex items-center justify-center gap-2"
        >
          <span className="text-elq-orange">—</span>
          EUROLEAGUE
          <span className="text-elq-orange">—</span>
        </div>
        <div className="font-display text-3xl sm:text-4xl text-elq-orange tracking-widest mt-0.5 flex items-center justify-center gap-2">
          <AccentDash />
          QUIZ
          <AccentDash />
        </div>
        <div className="w-24 h-0.5 bg-elq-dark/80 mx-auto mt-1 rounded-full" />
      </div>
    </div>
  );
}

export function LogoMini({ onClick, className = "" }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 hover:opacity-80 transition-opacity ${className}`}
      title="Home"
    >
      <LogoIcon size={32} />
      <span className="font-display text-sm tracking-wide text-elq-dark hidden sm:inline">
        EL<span className="text-elq-orange">Q</span>
      </span>
    </button>
  );
}

function AccentDash() {
  return (
    <svg width="16" height="4" viewBox="0 0 16 4" className="text-elq-orange">
      <rect x="0" y="1" width="6" height="2" rx="1" fill="currentColor" />
      <rect x="9" y="1" width="4" height="2" rx="1" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

export function LogoIcon({ size = 64 }) {
  const s = size;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Basketball body */}
      <circle cx="52" cy="56" r="44" fill="#FF6600" />

      {/* Dark crescent left edge */}
      <path
        d="M20 28C10 40 8 56 12 72C16 88 28 98 42 102C30 98 18 86 14 68C10 50 14 36 20 28Z"
        fill="#0F1923"
      />

      {/* Basketball seam lines */}
      <path
        d="M22 32C30 56 50 78 82 86"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.5"
      />
      <path
        d="M52 12C52 12 40 44 52 56C64 68 92 56 92 56"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.4"
      />
      <path
        d="M26 76C26 76 52 64 56 56C60 48 52 20 52 20"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.3"
      />

      {/* Stylized "E" on the ball */}
      <text
        x="42"
        y="70"
        fontFamily="'Bebas Neue', Impact, sans-serif"
        fontSize="52"
        fontWeight="bold"
        fill="white"
        opacity="0.9"
        fontStyle="italic"
      >
        E
      </text>

      {/* Question mark speech bubble */}
      <g transform="translate(76, 10)">
        {/* Bubble body */}
        <ellipse cx="18" cy="16" rx="16" ry="14" fill="#0F1923" />
        {/* Bubble tail */}
        <path d="M10 28L6 36L18 26" fill="#0F1923" />
        {/* Question mark */}
        <text
          x="18"
          y="22"
          fontFamily="'DM Sans', system-ui, sans-serif"
          fontSize="20"
          fontWeight="700"
          fill="white"
          textAnchor="middle"
        >
          ?
        </text>
        {/* Exclamation accents */}
        <line x1="34" y1="4" x2="38" y2="0" stroke="#0F1923" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="36" y1="12" x2="42" y2="10" stroke="#0F1923" strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export default LogoFull;
