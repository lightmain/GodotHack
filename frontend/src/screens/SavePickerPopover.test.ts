import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SaveConflictDialog,
  SaveImportErrorDialog,
  SavePickerPopover,
} from "./SavePickerPopover";

describe("SavePickerPopover", () => {
  it("renders ready saves and keeps unavailable saves disabled", () => {
    const html = renderToStaticMarkup(createElement(SavePickerPopover, {
      moduleId: "module-1",
      onContinue: vi.fn(),
      onExport: vi.fn(),
      onImport: vi.fn(),
      saves: [
        {
          path: "/save/0Ada",
          modifiedAt: 1_700_000_000_000,
          status: "ready",
          identity: {
            playerName: "Ada",
            role: "Wiz",
            race: "Hum",
            gender: "Fem",
            alignment: "Neu",
          },
        },
        {
          path: "/save/0Broken",
          modifiedAt: null,
          status: "damaged",
          reason: "truncated",
        },
      ],
    }));

    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-label="Saved games"/);
    expect(html).toMatch(/Ada/);
    expect(html).toMatch(/Wiz · Hum · Fem · Neu/);
    expect(html).not.toMatch(/Ready to continue/);
    expect(html).toMatch(/incompatible|damaged/i);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Broken/i);
    expect(html).toMatch(/Import save/i);
    expect(html).toMatch(/type="file"/i);
    expect(html).toMatch(/aria-label="Export save Ada"/);
    expect(html).toMatch(/aria-label="Export save Broken"/);
    expect(html).toMatch(/aria-label="Delete save Ada"/);
    expect(html).toMatch(/aria-label="Delete save Broken"/);
    expect(html.indexOf('aria-label="Delete save Ada"'))
      .toBeGreaterThan(html.indexOf(">Ada<"));
    expect(html.indexOf('aria-label="Delete save Broken"'))
      .toBeGreaterThan(html.indexOf(">Broken<"));
    expect(html).not.toMatch(/>\s*Back\s*</);
  });

  it("renders an import action and empty state without local saves", () => {
    const html = renderToStaticMarkup(createElement(SavePickerPopover, {
      moduleId: "module-1",
      onContinue: vi.fn(),
      onExport: vi.fn(),
      onImport: vi.fn(),
      saves: [],
    }));

    expect(html).toMatch(/Import save/i);
    expect(html).toMatch(/No saved games/i);
  });
});

describe("raw save import dialogs", () => {
  const identity = {
    playerName: "Ada",
    role: "Wiz",
    race: "Hum",
    gender: "Fem",
    alignment: "Neu",
  };

  it("shows both save summaries and explicit cancel or overwrite choices", () => {
    const html = renderToStaticMarkup(createElement(SaveConflictDialog, {
      conflict: {
        status: "conflict",
        path: "/save/0Ada",
        existing: { identity, modifiedAt: 1_700_000_000_000 },
        incoming: {
          identity: { ...identity, role: "Arc", alignment: "Law" },
          modifiedAt: 1_725_000_000_000,
        },
      },
      onCancel: vi.fn(),
      onOverwrite: vi.fn(),
      pending: false,
    }));

    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/Ada/);
    expect(html).toMatch(/Existing[\s\S]*Wiz[\s\S]*Hum[\s\S]*Fem[\s\S]*Neu/);
    expect(html).toMatch(/Incoming[\s\S]*Arc[\s\S]*Hum[\s\S]*Fem[\s\S]*Law/);
    expect(html).toMatch(/Cancel/);
    expect(html).toMatch(/Overwrite/);
  });

  it("requires an explicit confirmation for an import error", () => {
    const html = renderToStaticMarkup(createElement(SaveImportErrorDialog, {
      message: "Save is incompatible with this BlissHack build",
      onConfirm: vi.fn(),
    }));

    expect(html).toMatch(/role="alertdialog"/);
    expect(html).toMatch(/incompatible/i);
    expect(html).toMatch(/OK/);
  });
});
