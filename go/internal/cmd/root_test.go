package cmd

import (
	"testing"
)

func TestRootHasCommands(t *testing.T) {
	root := NewRoot()
	names := make(map[string]bool)
	for _, c := range root.Commands() {
		names[c.Name()] = true
	}

	for _, expected := range []string{"init", "update", "print"} {
		if !names[expected] {
			t.Fatalf("expected command %q to be registered", expected)
		}
	}
}
