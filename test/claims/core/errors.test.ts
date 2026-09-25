import { describe, expect, test } from "vitest";
import {
  ClaimsError,
  ClaimsPageMissingError,
  ClaimsPersistenceError,
  ClaimsPersistenceSecurityError,
  ClaimSessionError,
  EvidenceResolutionError,
  EvidenceResourceError,
  EvidenceSecurityError,
} from "../../../src/claims/core/errors.ts";

describe("Claims errors", () => {
  test.each([
    {
      ErrorType: ClaimsPersistenceError,
      expectedName: "ClaimsPersistenceError",
    },
    {
      ErrorType: ClaimsPageMissingError,
      expectedName: "ClaimsPageMissingError",
    },
    {
      ErrorType: ClaimsPersistenceSecurityError,
      expectedName: "ClaimsPersistenceSecurityError",
    },
    { ErrorType: ClaimSessionError, expectedName: "ClaimSessionError" },
    {
      ErrorType: EvidenceResolutionError,
      expectedName: "EvidenceResolutionError",
    },
    {
      ErrorType: EvidenceSecurityError,
      expectedName: "EvidenceSecurityError",
    },
    { ErrorType: EvidenceResourceError, expectedName: "EvidenceResourceError" },
  ])(
    "$expectedName retains the ClaimsError family",
    ({ ErrorType, expectedName }) => {
      const error = new ErrorType("detail");

      expect(error).toBeInstanceOf(ClaimsError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(expectedName);
      expect(error.message).toBe("detail");

      if (
        error instanceof ClaimsPageMissingError ||
        error instanceof ClaimsPersistenceSecurityError
      ) {
        expect(error).toBeInstanceOf(ClaimsPersistenceError);
      }
      if (error instanceof EvidenceSecurityError) {
        expect(error).toBeInstanceOf(EvidenceResolutionError);
      }
    },
  );
});
