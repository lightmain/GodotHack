import { describe, expect, it } from "vitest";
import { createDefaultProfile } from "./profile";
import { diffProfiles } from "./profile-diff";

describe("profile differences", () => {
  it("returns no rows for equal profiles", () => {
    expect(diffProfiles(
      createDefaultProfile(),
      createDefaultProfile(),
    )).toEqual([]);
  });

  it("reports changed fields in stable Settings order", () => {
    const current = createDefaultProfile();
    const incoming = createDefaultProfile();
    incoming.interface.terminalFontSize = "large";
    incoming.nethack.autopickup = false;
    incoming.nethack.pickupTypes = {
      mode: "selected",
      classes: ["$", "?", "!"],
    };
    incoming.nethack.showTime = true;

    expect(diffProfiles(current, incoming)).toEqual([
      {
        path: "interface.terminalFontSize",
        label: "Terminal font size",
        current: "medium",
        incoming: "large",
      },
      {
        path: "nethack.autopickup",
        label: "Automatic pickup",
        current: "On",
        incoming: "Off",
      },
      {
        path: "nethack.pickupTypes",
        label: "Pickup categories",
        current: "All",
        incoming: "$?!",
      },
      {
        path: "nethack.showTime",
        label: "Show turn count",
        current: "Off",
        incoming: "On",
      },
    ]);
  });
});
