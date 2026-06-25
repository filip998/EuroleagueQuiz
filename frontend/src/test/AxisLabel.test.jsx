import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AxisLabel } from "../GameBoard";

// AxisLabel renders the row/column headers of the TicTacToe board. These tests
// focus on the three achievement/attribute axis types added once the backend
// began serving them (position / champion / stat_milestone) plus the graceful
// fallback for an unknown or label-less axis. Milestone copy must come straight
// from the backend display_label, never from hardcoded client strings.

describe("AxisLabel position axis", () => {
  it("renders the role as a short, distinctly-styled pill", () => {
    const { container } = render(
      <AxisLabel axis={{ axis_type: "position", value: "Guard", display_label: "Guard" }} />
    );

    expect(screen.getByText("Guard")).toBeInTheDocument();
    // A dedicated palette keeps a position pill visually distinct from a team cell.
    expect(container.firstChild.className).toContain("bg-sky-50");
  });

  it("renders each coarse position value the backend can send", () => {
    for (const role of ["Guard", "Forward", "Center"]) {
      const { unmount } = render(
        <AxisLabel axis={{ axis_type: "position", value: role, display_label: role }} />
      );
      expect(screen.getByText(role)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("AxisLabel champion axis", () => {
  it("renders a trophy badge with the backend label", () => {
    const { container } = render(
      <AxisLabel
        axis={{
          axis_type: "champion",
          value: "euroleague_champion",
          display_label: "EuroLeague champion",
        }}
      />
    );

    const chip = container.firstChild;
    expect(chip).toHaveTextContent(/\ud83c\udfc6\s*EuroLeague champion/);
    expect(chip.className).toContain("bg-yellow-50");
  });
});

describe("AxisLabel stat_milestone axis", () => {
  it("renders the backend display_label as a stat chip", () => {
    const { container } = render(
      <AxisLabel
        axis={{
          axis_type: "stat_milestone",
          value: "season_ppg_15",
          display_label: "15+ PPG season",
        }}
      />
    );

    const chip = container.firstChild;
    expect(chip).toHaveTextContent(/\ud83d\udcca\s*15\+ PPG season/);
    expect(chip.className).toContain("bg-rose-50");
  });

  it("renders whatever label the server sends (no hardcoded milestone strings)", () => {
    // A deliberately non-shipped label proves the chip is purely data-driven, so
    // backend calibration changes need no frontend edit.
    const { container } = render(
      <AxisLabel
        axis={{
          axis_type: "stat_milestone",
          value: "made_up_axis",
          display_label: "42+ steals (career)",
        }}
      />
    );

    // The long trailing word is split for mobile wrap-safety (#265), so assert
    // the full visible text via textContent rather than a single text node.
    expect(container.firstChild).toHaveTextContent("42+ steals (career)");
  });

  it("keeps long milestone labels wrap-friendly so the grid can't overflow", () => {
    const { container } = render(
      <AxisLabel
        axis={{
          axis_type: "stat_milestone",
          value: "career_1000_points",
          display_label: "1,000+ career points",
        }}
      />
    );

    expect(screen.getByText(/1,000\+ career points/)).toBeInTheDocument();
    // The label span wraps and the grid item can shrink below content width.
    const span = container.querySelector("span");
    expect(span.className).toContain("break-words");
    expect(container.firstChild.className).toContain("min-w-0");
  });
});

describe("AxisLabel played_with axis", () => {
  it("labels the teammate clue even when a headshot image is present", () => {
    render(
      <AxisLabel
        axis={{
          axis_type: "played_with",
          value: "42",
          display_label: "Vasilije Mičić",
          image_url: "https://example.com/micic.png",
        }}
      />
    );

    // The chip must never be a bare face: an explicit "Played with" label shows
    // alongside the headshot and the teammate's name.
    expect(screen.getByText(/Played with/)).toBeInTheDocument();
    expect(screen.getByText("Vasilije Mičić")).toBeInTheDocument();
    expect(screen.getByAltText("Vasilije Mičić")).toBeInTheDocument();
  });

  it("labels the teammate clue when there is no headshot image", () => {
    render(
      <AxisLabel
        axis={{
          axis_type: "played_with",
          value: "42",
          display_label: "Vasilije Mičić",
        }}
      />
    );

    expect(screen.getByText(/Played with/)).toBeInTheDocument();
    expect(screen.getByText("Vasilije Mičić")).toBeInTheDocument();
  });
});

describe("AxisLabel team axis", () => {
  it("exposes the full club name (not the raw code) as the logo's accessible label", () => {
    render(
      <AxisLabel
        axis={{
          axis_type: "team",
          value: "1",
          display_label: "Virtus Bologna",
          team_code: "VIR",
          team_name: "Virtus Bologna",
        }}
      />
    );

    // The visible chip text and the logo alt both use the full name; "VIR" never
    // surfaces to a screen reader.
    expect(screen.getByText("Virtus Bologna")).toBeInTheDocument();
    expect(screen.getByAltText("Virtus Bologna")).toBeInTheDocument();
    expect(screen.queryByAltText("VIR")).not.toBeInTheDocument();
  });
});

describe("AxisLabel fallback handling", () => {
  it("shows a neutral placeholder for an unknown axis type with no label", () => {
    const { container } = render(
      <AxisLabel axis={{ axis_type: "totally_new_type", value: "x" }} />
    );

    // An em dash instead of an empty chip, with the default slate styling.
    expect(screen.getByText("\u2014")).toBeInTheDocument();
    expect(container.firstChild.className).toContain("bg-slate-50");
  });

  it("still renders an unknown axis type's display_label when present", () => {
    render(
      <AxisLabel axis={{ axis_type: "future_type", value: "x", display_label: "Something new" }} />
    );

    expect(screen.getByText("Something new")).toBeInTheDocument();
  });
});

describe("AxisLabel mobile word-break guard (#265)", () => {
  const labelSpan = (container) =>
    container.querySelector("span.break-words");

  it("keeps the last two letters of a long club name unbreakable", () => {
    const { container } = render(
      <AxisLabel
        axis={{
          axis_type: "team",
          value: "1",
          display_label: "Olympiacos",
          team_name: "Olympiacos",
        }}
      />
    );

    // A nowrap span holds the trailing 2 chars so a forced break can't strand
    // a lone "s" ("Olympiaco" / "s").
    const nowrap = container.querySelector("span.whitespace-nowrap");
    expect(nowrap).not.toBeNull();
    expect(nowrap).toHaveTextContent("os");
    // The full name is still present (accessible name + copy/paste intact).
    expect(container.firstChild).toHaveTextContent("Olympiacos");
    // The outer label span keeps emergency wrapping so the head can break.
    expect(labelSpan(container).className).toContain("break-words");
  });

  it("protects long teammate names in played_with chips too", () => {
    const { container } = render(
      <AxisLabel
        axis={{
          axis_type: "played_with",
          value: "9",
          display_label: "Spanoulis",
        }}
      />
    );

    const nowrap = container.querySelector("span.whitespace-nowrap");
    expect(nowrap).toHaveTextContent("is");
    expect(container.firstChild).toHaveTextContent("Spanoulis");
  });

  it("leaves short labels unfragmented (no nowrap tail span)", () => {
    const { container } = render(
      <AxisLabel
        axis={{
          axis_type: "team",
          value: "1",
          display_label: "Real Madrid",
          team_name: "Real Madrid",
        }}
      />
    );

    expect(container.querySelector("span.whitespace-nowrap")).toBeNull();
    expect(screen.getByText("Real Madrid")).toBeInTheDocument();
  });

  it("does not split a multi-word label whose long word is non-terminal", () => {
    const { container } = render(
      <AxisLabel
        axis={{
          axis_type: "team",
          value: "1",
          display_label: "Fortitudo Bologna",
          team_name: "Fortitudo Bologna",
        }}
      />
    );

    // Trailing word "Bologna" (7) stays intact; the label wraps at the space.
    expect(container.querySelector("span.whitespace-nowrap")).toBeNull();
    expect(screen.getByText("Fortitudo Bologna")).toBeInTheDocument();
  });
});
