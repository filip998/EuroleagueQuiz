import "@testing-library/jest-dom";

// Mock static asset imports (images, etc.)
vi.mock("/logo-full.png?url", () => ({ default: "/logo-full.png" }));
