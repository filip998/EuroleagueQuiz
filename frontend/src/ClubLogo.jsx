/**
 * Club logo component.
 * Logos are stored in /logos/{code}.png where code is the lowercase euroleague_code.
 */
export default function ClubLogo({ code, size = 32, className = "" }) {
  if (!code) return null;
  const src = `/logos/${code.toLowerCase()}.png`;
  return (
    <img
      src={src}
      alt={code}
      width={size}
      height={size}
      className={`object-contain ${className}`}
      onError={(e) => { e.target.style.display = "none"; }}
    />
  );
}
