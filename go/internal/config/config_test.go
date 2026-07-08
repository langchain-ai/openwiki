package config

import (
	"testing"
)

func TestParseEnv(t *testing.T) {
	env := ParseEnv(`
# comment
OPENROUTER_API_KEY="sk-or-v1-test"
OPENWIKI_MODEL_ID=z-ai/glm-5.2

INVALID-KEY=nope
`)

	if env["OPENROUTER_API_KEY"] != "sk-or-v1-test" {
		t.Fatalf("expected parsed api key, got %q", env["OPENROUTER_API_KEY"])
	}
	if env["OPENWIKI_MODEL_ID"] != "z-ai/glm-5.2" {
		t.Fatalf("expected model id, got %q", env["OPENWIKI_MODEL_ID"])
	}
	if _, ok := env["INVALID-KEY"]; ok {
		t.Fatal("expected invalid key to be ignored")
	}
}

func TestIsValidModelID(t *testing.T) {
	cases := []struct {
		value string
		valid bool
	}{
		{"z-ai/glm-5.2", true},
		{"anthropic/claude-sonnet-5", true},
		{"", false},
		{"bad model", false},
		{"http://bad", false},
	}

	for _, tc := range cases {
		if got := IsValidModelID(tc.value); got != tc.valid {
			t.Fatalf("IsValidModelID(%q) = %v, want %v", tc.value, got, tc.valid)
		}
	}
}

func TestResolveModelID(t *testing.T) {
	t.Setenv("OPENWIKI_MODEL_ID", "")

	model, err := ResolveModelID("")
	if err != nil {
		t.Fatal(err)
	}
	if model != "z-ai/glm-5.2" {
		t.Fatalf("expected default model, got %q", model)
	}

	_, err = ResolveModelID("bad model")
	if err == nil {
		t.Fatal("expected invalid model error")
	}
}
