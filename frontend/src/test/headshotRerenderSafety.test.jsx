import { describe, it, expect } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { optimizeHeadshot, headshotSrcSet, handleHeadshotError } from "../imageUrl";

/*
 * Regression guard for handleHeadshotError's re-render-safety contract.
 *
 * The boards that render optimized headshots (PhotoQuizBoard, CareerQuizBoard,
 * GuessTheListRaceBoard) re-render on a 250ms `nowMs` timer while a round/reveal
 * is active. handleHeadshotError falls back by imperatively setting
 * `img.src = originalUrl`. This test proves that an unrelated state-driven
 * re-render does NOT revert that imperative DOM mutation: because the optimized
 * `src`/`srcSet` props are value-identical across renders, React excludes them
 * from the commit payload and leaves the fallback in place (no error/retry loop,
 * no spurious placeholder).
 */
const CDN = "https://media-cdn.incrowdsports.com/probe.png";

function Clue({ url }) {
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  const optimized = optimizeHeadshot(url, { width: 384 });
  const srcSet = headshotSrcSet(url, [384, 768]);
  return (
    <div>
      <button onClick={() => setTick((t) => t + 1)}>tick-{tick}</button>
      {failed ? (
        <span data-testid="placeholder">placeholder</span>
      ) : (
        <img
          data-testid="clue"
          src={optimized}
          srcSet={srcSet}
          alt="clue"
          onError={(e) => handleHeadshotError(e, url, () => setFailed(true))}
        />
      )}
    </div>
  );
}

describe("headshot fallback re-render safety", () => {
  it("keeps the original-url fallback across unrelated (timer-style) re-renders", () => {
    render(<Clue url={CDN} />);
    const img = screen.getByTestId("clue");
    expect(img.getAttribute("src")).toBe(`${CDN}?width=384&format=webp`);
    expect(img.hasAttribute("srcset")).toBe(true);

    // First (optimized) failure -> swap to the original url and drop srcset.
    fireEvent.error(img);
    expect(img.getAttribute("src")).toBe(CDN);
    expect(img.hasAttribute("srcset")).toBe(false);

    // Several unrelated state-driven re-renders, like the 250ms nowMs tick.
    act(() => fireEvent.click(screen.getByRole("button")));
    act(() => fireEvent.click(screen.getByRole("button")));
    act(() => fireEvent.click(screen.getByRole("button")));

    // React must not have re-applied the unchanged optimized src/srcSet props.
    const after = screen.getByTestId("clue");
    expect(after.getAttribute("src")).toBe(CDN);
    expect(after.hasAttribute("srcset")).toBe(false);
    expect(screen.queryByTestId("placeholder")).not.toBeInTheDocument();
  });
});
