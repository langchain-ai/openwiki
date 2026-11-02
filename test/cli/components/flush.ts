import { act } from "react";

export async function flushInk(delayMilliseconds = 0): Promise<void> {
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    });
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}
