package tools

import (
	"fmt"
	"path/filepath"
	"strings"
)

// VirtualFS resolves virtual /-prefixed paths to the repository root.
type VirtualFS struct {
	Root string
}

// Resolve converts a virtual path to an absolute host path within the repo.
func (v *VirtualFS) Resolve(virtualPath string) (string, error) {
	trimmed := strings.TrimSpace(virtualPath)
	if trimmed == "" || trimmed == "/" || trimmed == "." {
		return v.Root, nil
	}

	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/" + trimmed
	}

	cleaned := filepath.Clean(trimmed)
	relative := strings.TrimPrefix(cleaned, string(filepath.Separator))
	if relative == "." {
		return v.Root, nil
	}

	abs := filepath.Join(v.Root, relative)
	abs, err := filepath.Abs(abs)
	if err != nil {
		return "", err
	}

	rootAbs, err := filepath.Abs(v.Root)
	if err != nil {
		return "", err
	}

	rel, err := filepath.Rel(rootAbs, abs)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes repository root: %s", virtualPath)
	}

	return abs, nil
}

// ToVirtual converts a host path to a virtual path for tool output.
func (v *VirtualFS) ToVirtual(hostPath string) string {
	abs, err := filepath.Abs(hostPath)
	if err != nil {
		return hostPath
	}
	rootAbs, err := filepath.Abs(v.Root)
	if err != nil {
		return hostPath
	}

	rel, err := filepath.Rel(rootAbs, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return hostPath
	}

	if rel == "." {
		return "/"
	}
	return "/" + strings.ReplaceAll(rel, "\\", "/")
}
