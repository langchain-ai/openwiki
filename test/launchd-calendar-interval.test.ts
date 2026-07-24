import { describe, expect, test } from "vitest";
import { parseLaunchdCalendarInterval } from "../src/schedules.ts";

// launchd's StartCalendarInterval ANDs every field it is given, whereas cron
// ORs day-of-month and day-of-week when both are restricted. A cron like
// `0 2 3 6 1` means "June 3rd OR any Monday in June"; a plist that sets Day,
// Month, and Weekday together means "June 3rd AND a Monday", which almost never
// fires. The translator must refuse that combination (returning null so the
// caller warns) rather than install a near-dead timer (issue #410).

describe("parseLaunchdCalendarInterval", () => {
  test("maps a daily schedule with wildcard day/weekday", () => {
    expect(parseLaunchdCalendarInterval("30 2 * * *")).toEqual({
      Hour: 2,
      Minute: 30,
    });
  });

  test("maps a day-of-month-only schedule", () => {
    expect(parseLaunchdCalendarInterval("0 2 3 * *")).toEqual({
      Day: 3,
      Hour: 2,
      Minute: 0,
    });
  });

  test("maps a weekday-only schedule and normalizes Sunday (7 -> 0)", () => {
    expect(parseLaunchdCalendarInterval("0 2 * * 1")).toEqual({
      Hour: 2,
      Minute: 0,
      Weekday: 1,
    });
    expect(parseLaunchdCalendarInterval("0 2 * * 7")).toEqual({
      Hour: 2,
      Minute: 0,
      Weekday: 0,
    });
  });

  test("maps a monthly schedule with day and month set", () => {
    expect(parseLaunchdCalendarInterval("0 2 3 6 *")).toEqual({
      Day: 3,
      Hour: 2,
      Minute: 0,
      Month: 6,
    });
  });

  test("returns null when both day-of-month and weekday are restricted", () => {
    // cron OR semantics can't be represented by launchd's AND, so refuse it.
    expect(parseLaunchdCalendarInterval("0 2 3 6 1")).toBeNull();
    expect(parseLaunchdCalendarInterval("0 2 3 * 1")).toBeNull();
  });

  test("returns null for ranges/steps it cannot represent", () => {
    expect(parseLaunchdCalendarInterval("*/15 2 * * *")).toBeNull();
    expect(parseLaunchdCalendarInterval("0 2 1-5 * *")).toBeNull();
  });
});
