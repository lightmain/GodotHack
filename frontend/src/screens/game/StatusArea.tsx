import { memo } from "react";
import {
  BL_CONDITION,
  type GameSnapshot,
  type StatusValue,
} from "../../game-state";
import { buildHitPointBar } from "../../status-rendering";
import { colorClass, textAttributeClass } from "../../text-styling";

const CONDITION_NAMES = [
  "Bare",
  "Blind",
  "Busy",
  "Conf",
  "Deaf",
  "Iron",
  "Fly",
  "FoodPois",
  "Glow",
  "Grab",
  "Hallu",
  "Held",
  "Icy",
  "Lava",
  "Lev",
  "Parlyz",
  "Ride",
  "Sleep",
  "Slime",
  "Slippery",
  "Stone",
  "Strngl",
  "Stun",
  "Submerged",
  "TermIll",
  "Tethered",
  "Trapped",
  "Unconsc",
  "Wounded",
  "Holding",
] as const;

const STATUS_LINE_ONE = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const STATUS_LINE_TWO = [20, 10, 18, 19, 11, 12, 14, 13, 21, 15, 16, 17, 9] as const;
const STATUS_LINE_THREE = [23, 24, 25, 26] as const;

/**
 * Render status fields in compact terminal rows.
 * @param props - current game status values.
 * @returns formatted status area.
 */
export const StatusArea = memo(function StatusArea({
  status,
}: {
  status: GameSnapshot["status"];
}) {
  const conditions = statusConditions(status[BL_CONDITION]);
  const title = status[0];
  const hitPoints = status[18];

  return (
    <section className="nh-status" aria-label="Character status">
      <div>
        {title && hitPoints && (
          <StatusTitleBar hitPoints={hitPoints} title={title} />
        )}
        {statusEntries(status, STATUS_LINE_ONE).map(renderStatusField)}
      </div>
      <div>
        {statusEntries(status, STATUS_LINE_TWO).map(renderStatusField)}
        {conditions.map((condition) => (
          <span className="nh-condition" key={condition}>{condition}</span>
        ))}
      </div>
      <div>
        {statusEntries(status, STATUS_LINE_THREE).map(renderStatusField)}
      </div>
    </section>
  );
});

function StatusTitleBar({
  title,
  hitPoints,
}: {
  title: StatusValue;
  hitPoints: StatusValue;
}) {
  const bar = buildHitPointBar(title.text, hitPoints.percent);
  return (
    <span
      aria-label={`${bar.text.trimEnd()}, ${bar.percent}% HP`}
      className={`nh-hp-bar ${textAttributeClass(title.attributes)}`}
    >
      <span aria-hidden="true">[</span>
      <span
        aria-hidden="true"
        className={`nh-hp-fill nh-hp-${bar.tone}`}
      >
        {bar.filled}
      </span>
      <span aria-hidden="true" className="nh-hp-empty">{bar.empty}</span>
      <span aria-hidden="true">]</span>
    </span>
  );
}

function statusEntries(
  status: GameSnapshot["status"],
  fields: readonly number[],
): Array<{ field: number; value: StatusValue }> {
  return fields.flatMap((field) => {
    const value = status[field];
    return value?.text.trim() ? [{ field, value }] : [];
  });
}

function renderStatusField(entry: { field: number; value: StatusValue }) {
  return (
    <span
      className={`${colorClass(entry.value.color)} ${textAttributeClass(entry.value.attributes)}`}
      key={entry.field}
    >
      {entry.value.text.trim()}
    </span>
  );
}

function statusConditions(status: StatusValue | undefined): string[] {
  const mask = status?.conditionMask ?? 0;
  return CONDITION_NAMES.filter((_, index) => (mask & (1 << index)) !== 0);
}
