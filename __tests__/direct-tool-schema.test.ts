import { describe, expect, it } from "vitest";
import { normalizeDirectToolInputSchema } from "../utils.ts";

describe("normalizeDirectToolInputSchema", () => {
  it("removes top-level draft metadata and strict additional properties", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: { type: "string" },
        options: {
          type: "object",
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    };

    expect(normalizeDirectToolInputSchema(schema)).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        options: {
          type: "object",
          additionalProperties: false,
        },
      },
      required: ["query"],
    });
  });

  it("preserves permissive and schema-valued additionalProperties", () => {
    expect(normalizeDirectToolInputSchema({
      type: "object",
      additionalProperties: true,
      properties: {
        nested: {
          type: "object",
          additionalProperties: false,
        },
      },
    })).toEqual({
      type: "object",
      additionalProperties: true,
      properties: {
        nested: {
          type: "object",
          additionalProperties: false,
        },
      },
    });

    expect(normalizeDirectToolInputSchema({
      type: "object",
      additionalProperties: { type: "string" },
      properties: {
        nested: {
          type: "object",
          additionalProperties: { type: "number" },
        },
      },
    })).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
      properties: {
        nested: {
          type: "object",
          additionalProperties: { type: "number" },
        },
      },
    });
  });

  it("uses an empty object schema when the MCP tool omits inputSchema", () => {
    expect(normalizeDirectToolInputSchema(undefined)).toEqual({ type: "object", properties: {} });
  });
});
