package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVirtualFSResolve(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	vfs := &VirtualFS{Root: root}

	readme, err := vfs.Resolve("/README.md")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(readme) != "README.md" {
		t.Fatalf("unexpected path %s", readme)
	}

	outside, err := vfs.Resolve("/../../../outside")
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(root, outside)
	if err != nil || strings.HasPrefix(rel, "..") {
		t.Fatalf("expected path to stay within repo root, got %q", outside)
	}
}

func TestRegistryWriteAndRead(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry(root)

	_, err := registry.Execute("write_file", `{"path":"/notes.md","content":"# Notes"}`)
	if err != nil {
		t.Fatal(err)
	}

	output, err := registry.Execute("read_file", `{"path":"/notes.md"}`)
	if err != nil {
		t.Fatal(err)
	}
	if output != "# Notes" {
		t.Fatalf("unexpected content %q", output)
	}
}

func TestRegistryEditFile(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry(root)

	_, err := registry.Execute("write_file", `{"path":"/doc.md","content":"alpha beta"}`)
	if err != nil {
		t.Fatal(err)
	}

	_, err = registry.Execute("edit_file", `{"path":"/doc.md","old_string":"beta","new_string":"gamma"}`)
	if err != nil {
		t.Fatal(err)
	}

	output, err := registry.Execute("read_file", `{"path":"/doc.md"}`)
	if err != nil {
		t.Fatal(err)
	}
	if output != "alpha gamma" {
		t.Fatalf("unexpected content %q", output)
	}
}

func TestRegistryGlobAndGrep(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry(root)

	if err := os.WriteFile(filepath.Join(root, "a.go"), []byte("package main\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "b.txt"), []byte("nothing here\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	globOut, err := registry.Execute("glob", `{"pattern":"*.go","path":"/"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(globOut, "/a.go") {
		t.Fatalf("expected go match, got %q", globOut)
	}

	grepOut, err := registry.Execute("grep", `{"pattern":"package","path":"/"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(grepOut, "a.go:1:package main") {
		t.Fatalf("expected grep match, got %q", grepOut)
	}
}

func TestRegistryExecute(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry(root)

	output, err := registry.Execute("execute", `{"command":"echo hello"}`)
	if err != nil {
		t.Fatal(err)
	}
	if output != "hello" {
		t.Fatalf("unexpected output %q", output)
	}
}
