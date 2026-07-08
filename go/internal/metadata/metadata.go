package metadata

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/langchain-ai/openwiki/go/internal/constants"
)

// UpdateMetadata records the last successful documentation run.
type UpdateMetadata struct {
	UpdatedAt string             `json:"updatedAt"`
	Command   constants.Command  `json:"command"`
	GitHead   string             `json:"gitHead,omitempty"`
	Model     string             `json:"model"`
}

// ReadLastUpdate reads prior run metadata if present and valid.
func ReadLastUpdate(cwd string) (*UpdateMetadata, error) {
	metadataFile := filepath.Join(cwd, constants.UpdateMetadataPath)

	content, err := os.ReadFile(metadataFile)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var parsed struct {
		UpdatedAt string `json:"updatedAt"`
		Command   string `json:"command"`
		GitHead   string `json:"gitHead"`
		Model     string `json:"model"`
	}
	if err := json.Unmarshal(content, &parsed); err != nil {
		return nil, nil
	}

	if parsed.UpdatedAt == "" || parsed.Command == "" || parsed.Model == "" {
		return nil, nil
	}

	command := constants.CommandUpdate
	if parsed.Command == "init" {
		command = constants.CommandInit
	}

	return &UpdateMetadata{
		UpdatedAt: parsed.UpdatedAt,
		Command:   command,
		GitHead:   parsed.GitHead,
		Model:     parsed.Model,
	}, nil
}

// WriteLastUpdateMetadata records a successful init/update run.
func WriteLastUpdateMetadata(command constants.Command, cwd, modelID, gitHead string) error {
	metadataFile := filepath.Join(cwd, constants.UpdateMetadataPath)
	metadata := UpdateMetadata{
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Command:   command,
		GitHead:   gitHead,
		Model:     modelID,
	}

	if err := os.MkdirAll(filepath.Dir(metadataFile), 0o755); err != nil {
		return err
	}

	encoded, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(metadataFile, append(encoded, '\n'), 0o644)
}

// ContentSnapshot is a SHA-256 hash of openwiki/ content.
type ContentSnapshot string

// CreateContentSnapshot hashes openwiki/ excluding .last-update.json.
func CreateContentSnapshot(cwd string) (ContentSnapshot, error) {
	openWikiDir := filepath.Join(cwd, constants.OpenWikiDir)
	hash := sha256.New()

	if err := addDirectoryToSnapshot(hash, openWikiDir, ""); err != nil {
		return "", err
	}

	return ContentSnapshot(fmt.Sprintf("%x", hash.Sum(nil))), nil
}

func addDirectoryToSnapshot(hash io.Writer, directory, relativeDirectory string) error {
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		_, _ = hash.Write([]byte("missing"))
		return nil
	}
	if err != nil {
		return err
	}

	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].Name() < entries[i].Name() {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}

	for _, entry := range entries {
		entryPath := filepath.Join(directory, entry.Name())
		relativePath := filepath.Join(relativeDirectory, entry.Name())
		relativePath = strings.ReplaceAll(relativePath, "\\", "/")

		if relativePath == filepath.Base(constants.UpdateMetadataPath) {
			continue
		}

		if entry.IsDir() {
			if _, err := hash.Write([]byte("dir:" + relativePath + "\x00")); err != nil {
				return err
			}
			if err := addDirectoryToSnapshot(hash, entryPath, relativePath); err != nil {
				return err
			}
			continue
		}

		if !entry.Type().IsRegular() {
			continue
		}

		content, err := os.ReadFile(entryPath)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}

		if _, err := hash.Write([]byte("file:" + relativePath + "\x00")); err != nil {
			return err
		}
		if _, err := hash.Write(content); err != nil {
			return err
		}
		if _, err := hash.Write([]byte("\x00")); err != nil {
			return err
		}
	}

	return nil
}
