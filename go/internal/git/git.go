package git

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"

	"github.com/langchain-ai/openwiki/go/internal/constants"
	"github.com/langchain-ai/openwiki/go/internal/metadata"
)

// RunContext holds per-run git and metadata context for prompts.
type RunContext struct {
	LastUpdate *metadata.UpdateMetadata
	GitSummary string
}

// UpdateNoopStatus describes whether an update run should be skipped.
type UpdateNoopStatus struct {
	ShouldSkip bool
	GitHead    string
	Model      string
	Reason     string
}

// CreateRunContext builds prompt context for init/update/chat runs.
func CreateRunContext(command constants.Command, cwd string) (*RunContext, error) {
	lastUpdate, err := metadata.ReadLastUpdate(cwd)
	if err != nil {
		return nil, err
	}

	if command == constants.CommandChat {
		return &RunContext{
			LastUpdate: lastUpdate,
			GitSummary: "Not applicable for chat.",
		}, nil
	}

	summary, err := createGitSummary(command, cwd, lastUpdate)
	if err != nil {
		return nil, err
	}

	return &RunContext{
		LastUpdate: lastUpdate,
		GitSummary: summary,
	}, nil
}

// GetUpdateNoopStatus checks whether an update can be skipped.
func GetUpdateNoopStatus(cwd string) (*UpdateNoopStatus, error) {
	lastUpdate, err := metadata.ReadLastUpdate(cwd)
	if err != nil {
		return nil, err
	}

	if lastUpdate == nil || lastUpdate.GitHead == "" {
		return &UpdateNoopStatus{ShouldSkip: false, Reason: "missing previous update git head"}, nil
	}

	head, err := GetHead(cwd)
	if err != nil {
		return nil, err
	}
	if head == "" {
		return &UpdateNoopStatus{ShouldSkip: false, Reason: "missing current git head"}, nil
	}

	status, err := Run(cwd, "status", "--short", "--untracked-files=all")
	if err != nil {
		return nil, err
	}

	for _, line := range strings.Split(status, "\n") {
		trimmed := strings.TrimRight(line, " \t")
		if trimmed == "" {
			continue
		}
		if !isUpdateMetadataStatusLine(trimmed) {
			return &UpdateNoopStatus{ShouldSkip: false, Reason: "worktree has changes"}, nil
		}
	}

	if head != lastUpdate.GitHead {
		changedPaths, err := getChangedPathsSinceLastUpdate(cwd, lastUpdate.GitHead)
		if err != nil {
			return nil, err
		}

		if len(changedPaths) == 0 {
			return &UpdateNoopStatus{ShouldSkip: false, Reason: "git head changed"}, nil
		}

		for _, changedPath := range changedPaths {
			if !isOpenWikiPath(changedPath) {
				return &UpdateNoopStatus{ShouldSkip: false, Reason: "git head changed"}, nil
			}
		}
	}

	return &UpdateNoopStatus{
		ShouldSkip: true,
		GitHead:    head,
		Model:      lastUpdate.Model,
	}, nil
}

// GetHead returns the current git HEAD.
func GetHead(cwd string) (string, error) {
	head, err := Run(cwd, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(head), nil
}

// Run executes a git command and returns combined stdout/stderr.
func Run(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"--no-pager"}, args...)...)
	cmd.Dir = cwd

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	output := strings.TrimSpace(strings.TrimSpace(stdout.String() + "\n" + stderr.String()))

	if err != nil {
		if output != "" {
			return output, nil
		}
		return "", err
	}

	return output, nil
}

func createGitSummary(command constants.Command, cwd string, lastUpdate *metadata.UpdateMetadata) (string, error) {
	var sections []string

	status, err := Run(cwd, "status", "--short")
	if err != nil {
		return "", err
	}
	sections = append(sections, formatGitSection("git status --short", status))

	head, err := GetHead(cwd)
	if err != nil {
		return "", err
	}
	if head == "" {
		sections = append(sections, formatGitSection("git rev-parse HEAD", "(unknown)"))
	} else {
		sections = append(sections, formatGitSection("git rev-parse HEAD", head))
	}

	if command == constants.CommandUpdate && lastUpdate != nil && lastUpdate.GitHead != "" {
		logSince, err := Run(cwd, "log", lastUpdate.GitHead+"..HEAD", "--name-status", "--oneline")
		if err != nil {
			return "", err
		}
		sections = append(sections, formatGitSection(
			fmt.Sprintf("git log %s..HEAD --name-status --oneline", lastUpdate.GitHead),
			logSince,
		))
	} else if command == constants.CommandUpdate && lastUpdate != nil && lastUpdate.UpdatedAt != "" {
		logSince, err := Run(cwd, "log", "--since", lastUpdate.UpdatedAt, "--name-status", "--oneline")
		if err != nil {
			return "", err
		}
		sections = append(sections, formatGitSection(
			fmt.Sprintf("git log --since %s --name-status --oneline", lastUpdate.UpdatedAt),
			logSince,
		))
	} else {
		recentLog, err := Run(cwd, "log", "--max-count=20", "--name-status", "--oneline")
		if err != nil {
			return "", err
		}
		if command == constants.CommandUpdate {
			sections = append(sections, "No prior OpenWiki update timestamp was found.")
		}
		sections = append(sections, formatGitSection(
			"git log --max-count=20 --name-status --oneline",
			recentLog,
		))
	}

	diff, err := Run(cwd, "diff", "--name-status", "HEAD")
	if err != nil {
		return "", err
	}
	sections = append(sections, formatGitSection("git diff --name-status HEAD", diff))

	return strings.Join(sections, "\n\n"), nil
}

func formatGitSection(command, output string) string {
	if output == "" {
		output = "(no output)"
	}
	return "$ " + command + "\n" + output
}

func isUpdateMetadataStatusLine(line string) bool {
	statusPath := line
	if len(line) > 3 {
		statusPath = strings.TrimSpace(line[3:])
	} else {
		statusPath = strings.TrimSpace(line)
	}

	normalized := strings.ReplaceAll(statusPath, "\\", "/")
	return normalized == constants.UpdateMetadataPath ||
		strings.HasSuffix(normalized, " -> "+constants.UpdateMetadataPath)
}

func getChangedPathsSinceLastUpdate(cwd, gitHead string) ([]string, error) {
	diff, err := Run(cwd, "diff", "--name-only", gitHead+"..HEAD")
	if err != nil {
		return nil, err
	}

	var paths []string
	for _, line := range strings.Split(diff, "\n") {
		normalized := strings.TrimSpace(strings.ReplaceAll(line, "\\", "/"))
		if normalized != "" {
			paths = append(paths, normalized)
		}
	}
	return paths, nil
}

func isOpenWikiPath(changedPath string) bool {
	return changedPath == constants.OpenWikiDir ||
		strings.HasPrefix(changedPath, constants.OpenWikiDir+"/")
}
