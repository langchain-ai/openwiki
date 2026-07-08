package tools

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Registry provides filesystem and shell tools for the agent.
type Registry struct {
	fs *VirtualFS
}

// NewRegistry creates a tool registry rooted at the repository.
func NewRegistry(root string) *Registry {
	return &Registry{fs: &VirtualFS{Root: root}}
}

// Execute runs a tool by name with JSON arguments.
func (r *Registry) Execute(name, argsJSON string) (string, error) {
	switch name {
	case "ls":
		return r.ls(argsJSON)
	case "read_file":
		return r.readFile(argsJSON)
	case "write_file":
		return r.writeFile(argsJSON)
	case "edit_file":
		return r.editFile(argsJSON)
	case "glob":
		return r.glob(argsJSON)
	case "grep":
		return r.grep(argsJSON)
	case "execute":
		return r.execute(argsJSON)
	default:
		return "", fmt.Errorf("unknown tool: %s", name)
	}
}

type lsArgs struct {
	Path string `json:"path"`
}

func (r *Registry) ls(argsJSON string) (string, error) {
	var args lsArgs
	if argsJSON != "" {
		if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
			return "", err
		}
	}

	target, err := r.fs.Resolve(args.Path)
	if err != nil {
		return "", err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return "", err
	}

	var lines []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			name += "/"
		}
		lines = append(lines, name)
	}

	if len(lines) == 0 {
		return "(empty directory)", nil
	}
	return strings.Join(lines, "\n"), nil
}

type readFileArgs struct {
	Path   string `json:"path"`
	Offset int    `json:"offset"`
	Limit  int    `json:"limit"`
}

func (r *Registry) readFile(argsJSON string) (string, error) {
	var args readFileArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return "", err
	}
	if args.Path == "" {
		return "", fmt.Errorf("path is required")
	}

	target, err := r.fs.Resolve(args.Path)
	if err != nil {
		return "", err
	}

	content, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}

	lines := strings.Split(string(content), "\n")
	start := args.Offset
	if start < 0 {
		start = 0
	}
	if start >= len(lines) {
		return "", nil
	}

	end := len(lines)
	if args.Limit > 0 {
		end = start + args.Limit
		if end > len(lines) {
			end = len(lines)
		}
	}

	selected := lines[start:end]
	return strings.Join(selected, "\n"), nil
}

type writeFileArgs struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (r *Registry) writeFile(argsJSON string) (string, error) {
	var args writeFileArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return "", err
	}
	if args.Path == "" {
		return "", fmt.Errorf("path is required")
	}

	target, err := r.fs.Resolve(args.Path)
	if err != nil {
		return "", err
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}

	if err := os.WriteFile(target, []byte(args.Content), 0o644); err != nil {
		return "", err
	}

	return fmt.Sprintf("Wrote %s", r.fs.ToVirtual(target)), nil
}

type editFileArgs struct {
	Path       string `json:"path"`
	OldString  string `json:"old_string"`
	NewString  string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all"`
}

func (r *Registry) editFile(argsJSON string) (string, error) {
	var args editFileArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return "", err
	}
	if args.Path == "" {
		return "", fmt.Errorf("path is required")
	}
	if args.OldString == "" {
		return "", fmt.Errorf("old_string is required")
	}

	target, err := r.fs.Resolve(args.Path)
	if err != nil {
		return "", err
	}

	content, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}

	text := string(content)
	if args.ReplaceAll {
		if !strings.Contains(text, args.OldString) {
			return "", fmt.Errorf("old_string not found in %s", args.Path)
		}
		text = strings.ReplaceAll(text, args.OldString, args.NewString)
	} else {
		index := strings.Index(text, args.OldString)
		if index < 0 {
			return "", fmt.Errorf("old_string not found in %s", args.Path)
		}
		text = text[:index] + args.NewString + text[index+len(args.OldString):]
	}

	if err := os.WriteFile(target, []byte(text), 0o644); err != nil {
		return "", err
	}

	return fmt.Sprintf("Edited %s", r.fs.ToVirtual(target)), nil
}

type globArgs struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
}

func (r *Registry) glob(argsJSON string) (string, error) {
	var args globArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return "", err
	}
	if args.Pattern == "" {
		return "", fmt.Errorf("pattern is required")
	}

	searchRoot, err := r.fs.Resolve(args.Path)
	if err != nil {
		return "", err
	}

	matches, err := filepath.Glob(filepath.Join(searchRoot, args.Pattern))
	if err != nil {
		return "", err
	}

	var virtualMatches []string
	for _, match := range matches {
		virtualMatches = append(virtualMatches, r.fs.ToVirtual(match))
	}

	if len(virtualMatches) == 0 {
		return "(no matches)", nil
	}
	return strings.Join(virtualMatches, "\n"), nil
}

type grepArgs struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
	Glob    string `json:"glob"`
}

func (r *Registry) grep(argsJSON string) (string, error) {
	var args grepArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return "", err
	}
	if args.Pattern == "" {
		return "", fmt.Errorf("pattern is required")
	}

	re, err := regexp.Compile(args.Pattern)
	if err != nil {
		return "", err
	}

	searchRoot, err := r.fs.Resolve(args.Path)
	if err != nil {
		return "", err
	}

	var matches []string
	err = filepath.WalkDir(searchRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			base := d.Name()
			if base == ".git" || base == "node_modules" || base == "dist" || base == "build" {
				return filepath.SkipDir
			}
			return nil
		}

		if args.Glob != "" {
			ok, err := filepath.Match(args.Glob, filepath.Base(path))
			if err != nil {
				return err
			}
			if !ok {
				return nil
			}
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return nil
		}

		lines := strings.Split(string(content), "\n")
		for i, line := range lines {
			if re.MatchString(line) {
				matches = append(matches, fmt.Sprintf("%s:%d:%s", r.fs.ToVirtual(path), i+1, line))
			}
		}
		return nil
	})
	if err != nil {
		return "", err
	}

	if len(matches) == 0 {
		return "(no matches)", nil
	}
	return strings.Join(matches, "\n"), nil
}
