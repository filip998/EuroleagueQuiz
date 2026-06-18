import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useListKeyboardNav } from "../useListKeyboardNav";

function keyEvent(name) {
  return { key: name, preventDefault: vi.fn() };
}

const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe("useListKeyboardNav", () => {
  it("starts with nothing highlighted", () => {
    const { result } = renderHook(() => useListKeyboardNav(items, vi.fn()));
    expect(result.current.activeIndex).toBe(-1);
  });

  it("ArrowDown moves the highlight down and clamps at the last row", () => {
    const { result } = renderHook(() => useListKeyboardNav(items, vi.fn()));

    const first = keyEvent("ArrowDown");
    act(() => result.current.handleKeyDown(first));
    expect(result.current.activeIndex).toBe(0);
    expect(first.preventDefault).toHaveBeenCalled();

    act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));
    act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));
    expect(result.current.activeIndex).toBe(2);

    // Clamp: does not move past the last row.
    act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));
    expect(result.current.activeIndex).toBe(2);
  });

  it("ArrowUp steps up and returns to the input (-1) from the first row without wrapping", () => {
    const { result } = renderHook(() => useListKeyboardNav(items, vi.fn()));

    act(() => result.current.handleKeyDown(keyEvent("ArrowDown"))); // 0
    act(() => result.current.handleKeyDown(keyEvent("ArrowDown"))); // 1
    act(() => result.current.handleKeyDown(keyEvent("ArrowUp"))); // 0
    expect(result.current.activeIndex).toBe(0);

    act(() => result.current.handleKeyDown(keyEvent("ArrowUp"))); // -1 (input)
    expect(result.current.activeIndex).toBe(-1);

    // No wrap-around to the last row.
    act(() => result.current.handleKeyDown(keyEvent("ArrowUp")));
    expect(result.current.activeIndex).toBe(-1);
  });

  it("Enter chooses the highlighted item", () => {
    const onChoose = vi.fn();
    const { result } = renderHook(() => useListKeyboardNav(items, onChoose));

    act(() => result.current.handleKeyDown(keyEvent("ArrowDown"))); // 0
    act(() => result.current.handleKeyDown(keyEvent("ArrowDown"))); // 1

    const enter = keyEvent("Enter");
    act(() => result.current.handleKeyDown(enter));
    expect(onChoose).toHaveBeenCalledWith(items[1]);
    expect(enter.preventDefault).toHaveBeenCalled();
  });

  it("Enter selects the only result when nothing is highlighted (shortcut preserved)", () => {
    const onChoose = vi.fn();
    const single = [{ id: 9 }];
    const { result } = renderHook(() => useListKeyboardNav(single, onChoose));

    act(() => result.current.handleKeyDown(keyEvent("Enter")));
    expect(onChoose).toHaveBeenCalledWith(single[0]);
  });

  it("Enter does nothing with multiple results and no highlight", () => {
    const onChoose = vi.fn();
    const { result } = renderHook(() => useListKeyboardNav(items, onChoose));

    const enter = keyEvent("Enter");
    act(() => result.current.handleKeyDown(enter));
    expect(onChoose).not.toHaveBeenCalled();
    expect(enter.preventDefault).not.toHaveBeenCalled();
  });

  it("resets the highlight to -1 when the items reference changes", () => {
    const { result, rerender } = renderHook(
      ({ list }) => useListKeyboardNav(list, vi.fn()),
      { initialProps: { list: items } }
    );

    act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));
    expect(result.current.activeIndex).toBe(0);

    rerender({ list: [{ id: 4 }, { id: 5 }] });
    expect(result.current.activeIndex).toBe(-1);
  });

  it("does not highlight or hijack arrow keys when the list is empty", () => {
    const onChoose = vi.fn();
    const { result } = renderHook(() => useListKeyboardNav([], onChoose));

    const down = keyEvent("ArrowDown");
    act(() => result.current.handleKeyDown(down));
    expect(result.current.activeIndex).toBe(-1);
    expect(down.preventDefault).not.toHaveBeenCalled();

    const enter = keyEvent("Enter");
    act(() => result.current.handleKeyDown(enter));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("scrolls the highlighted row into view while navigating", () => {
    const { result } = renderHook(() => useListKeyboardNav(items, vi.fn()));

    const row = { scrollIntoView: vi.fn() };
    result.current.activeItemRef.current = row;
    act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));

    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("does not navigate or select while disabled, even with items present", () => {
    const onChoose = vi.fn();
    const { result } = renderHook(() => useListKeyboardNav(items, onChoose, false));

    const down = keyEvent("ArrowDown");
    act(() => result.current.handleKeyDown(down));
    expect(result.current.activeIndex).toBe(-1);
    expect(down.preventDefault).not.toHaveBeenCalled();

    const enter = keyEvent("Enter");
    act(() => result.current.handleKeyDown(enter));
    expect(onChoose).not.toHaveBeenCalled();
    expect(enter.preventDefault).not.toHaveBeenCalled();
  });

  it("clears the highlight when the list becomes disabled (e.g. hidden while loading)", () => {
    const onChoose = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }) => useListKeyboardNav(items, onChoose, enabled),
      { initialProps: { enabled: true } }
    );

    act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));
    expect(result.current.activeIndex).toBe(0);

    // List hidden (loading / popup gated off): highlight resets and a stale
    // Enter can no longer select the row the user can't see.
    rerender({ enabled: false });
    expect(result.current.activeIndex).toBe(-1);

    act(() => result.current.handleKeyDown(keyEvent("Enter")));
    expect(onChoose).not.toHaveBeenCalled();
  });
});
