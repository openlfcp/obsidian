// E-020: which Data Profiles this version lists as a collaboration or a
// section, and the version gate (IDENTITY-PROFILE-01 §10, A§3.5a).

import { PROFILE_ID as TASKS_PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import {
  classifyProfile,
  listedAsResource,
  SERVICE_CONTROL_PROFILE_ID,
} from "../../../src/core/collab/profiles";

describe("E-020 profile classes", () => {
  it("knows the task, section and service-control profiles at their version", () => {
    expect(classifyProfile(TASKS_PROFILE_ID)).toEqual({ kind: "known", family: "tasks" });
    expect(classifyProfile(SECTIONS_PROFILE_ID)).toEqual({ kind: "known", family: "section" });
    expect(classifyProfile(SERVICE_CONTROL_PROFILE_ID)).toEqual({
      kind: "known",
      family: "service-control",
    });
  });

  it("version gate: a later version of a known family is newer, never read as the known one", () => {
    expect(classifyProfile("org.openlfcp.service-control.v2")).toEqual({
      kind: "newer",
      family: "service-control",
      version: 2,
    });
    expect(classifyProfile("org.openlfcp.shared-sections.v10")).toEqual({
      kind: "newer",
      family: "section",
      version: 10,
    });
    expect(classifyProfile("org.openlfcp.shared-objects.v3")).toMatchObject({ kind: "newer" });
    // An earlier or a malformed version is no version this one knows.
    for (const id of [
      "org.openlfcp.shared-objects.v0",
      "org.openlfcp.shared-objects.v01",
      "org.openlfcp.shared-objects.V1",
      "org.openlfcp.shared-objects",
    ])
      expect(classifyProfile(id)).toEqual({ kind: "unknown" });
  });

  it("anything else is unknown", () => {
    for (const id of ["org.openlfcp.identity.v1", "org.example.board.v1", "", "v1"])
      expect(classifyProfile(id)).toEqual({ kind: "unknown" });
  });

  it("lists only task collaborations and sections this version reads", () => {
    expect(listedAsResource(TASKS_PROFILE_ID)).toBe(true);
    expect(listedAsResource(SECTIONS_PROFILE_ID)).toBe(true);
    for (const id of [
      SERVICE_CONTROL_PROFILE_ID,
      "org.openlfcp.service-control.v2",
      "org.openlfcp.shared-sections.v2",
      "org.openlfcp.shared-objects.v2",
      "org.openlfcp.identity.v1",
      "org.example.board.v1",
    ])
      expect(listedAsResource(id)).toBe(false);
  });
});
