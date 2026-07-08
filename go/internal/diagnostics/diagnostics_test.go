package diagnostics

import (
	"errors"
	"testing"
)

func TestSanitizeDiagnosticText(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "sk-or-v1-secret")

	input := "failed with sk-or-v1-secret and sk-or-v1-other"
	result := SanitizeDiagnosticText(input)

	if result == input {
		t.Fatal("expected redaction")
	}
	if result == "" {
		t.Fatal("expected non-empty result")
	}
}

func TestGetErrorMessageOpenRouter500(t *testing.T) {
	err := errors.New("OpenRouterError: 500 Internal Server Error")
	message := GetErrorMessage(err)
	if message == err.Error() {
		t.Fatalf("expected friendly message, got %q", message)
	}
}
