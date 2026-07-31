// Re-export only. The parser lives in src/refText.ts so the browser and the engine cannot drift on
// what counts as a reference — a slash that means one thing in the box and another in the request is
// worse than either answer on its own.

export {
  toDisplay, fromDisplay, detectTrigger, refText, findRefs, setRefOptional,
  type RefColumn, type FoundRef,
} from "../../../src/refText.ts";
