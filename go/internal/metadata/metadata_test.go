package metadata

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/langchain-ai/openwiki/go/internal/constants"
)

func TestContentSnapshotIgnoresMetadata(t *testing.T) {
	root := t.TempDir()
	openWikiDir := filepath.Join(root, constants.OpenWikiDir)
	if err := os.MkdirAll(openWikiDir, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(openWikiDir, "quickstart.md"), []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(openWikiDir, ".last-update.json"), []byte(`{"updatedAt":"t","command":"init","model":"m"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	before, err := CreateContentSnapshot(root)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(openWikiDir, ".last-update.json"), []byte(`{"updatedAt":"t2","command":"init","model":"m"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	after, err := CreateContentSnapshot(root)
	if err != nil {
		t.Fatal(err)
	}

	if before != after {
		t.Fatalf("metadata changes should not affect snapshot: %s vs %s", before, after)
	}
}

func TestWriteAndReadLastUpdate(t *testing.T) {
	root := t.TempDir()

	if err := WriteLastUpdateMetadata(constants.CommandInit, root, "z-ai/glm-5.2", "abc123"); err != nil {
		t.Fatal(err)
	}

	lastUpdate, err := ReadLastUpdate(root)
	if err != nil {
		t.Fatal(err)
	}
	if lastUpdate == nil {
		t.Fatal("expected metadata")
	}
	if lastUpdate.Command != constants.CommandInit {
		t.Fatalf("unexpected command %s", lastUpdate.Command)
	}
	if lastUpdate.Model != "z-ai/glm-5.2" {
		t.Fatalf("unexpected model %s", lastUpdate.Model)
	}
	if lastUpdate.GitHead != "abc123" {
		t.Fatalf("unexpected git head %s", lastUpdate.GitHead)
	}
}
