/**
 * EuroLeague Quiz Logo
 * Full version: large logo image (for home screen)
 * Mini version: small logo image (for in-game top-left)
 */

import logoSrc from "/logo-full.png?url";

export function LogoFull({ className = "" }) {
  return (
    <div className={`flex flex-col items-center ${className}`}>
      <img
        src={logoSrc}
        alt="EuroLeague Quiz"
        className="w-64 sm:w-80 h-auto"
      />
    </div>
  );
}

export function LogoMini({ onClick, className = "" }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center hover:opacity-80 transition-opacity ${className}`}
      title="Home"
    >
      <img
        src={logoSrc}
        alt="EuroLeague Quiz"
        className="h-8 w-auto"
      />
    </button>
  );
}

export default LogoFull;
