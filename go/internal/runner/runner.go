package runner

import (
	"context"
	"fmt"

	"github.com/langchain-ai/openwiki/go/internal/agent"
	"github.com/langchain-ai/openwiki/go/internal/config"
	"github.com/langchain-ai/openwiki/go/internal/constants"
	"github.com/langchain-ai/openwiki/go/internal/git"
	"github.com/langchain-ai/openwiki/go/internal/metadata"
	"github.com/langchain-ai/openwiki/go/internal/output"
)

// Options configures a full OpenWiki run.
type Options struct {
	Command     constants.Command
	ModelFlag   string
	UserMessage string
	PrintMode   bool
	CWD         string
}

// Result is the outcome of a run.
type Result struct {
	Skipped bool
	Model   string
}

// Run executes init, update, or print commands.
func Run(ctx context.Context, opts Options) (*Result, error) {
	settings, err := config.LoadSettings(opts.ModelFlag, opts.CWD)
	if err != nil {
		return nil, err
	}

	if opts.Command == constants.CommandUpdate && shouldCheckUpdateNoop(opts.UserMessage) {
		noop, err := git.GetUpdateNoopStatus(settings.CWD)
		if err != nil {
			return nil, err
		}
		if noop.ShouldSkip {
			message := "No repository changes detected since the last OpenWiki update; skipping agent run."
			out := output.NewWriter(outputMode(opts.PrintMode))
			out.OnText(message, "main")
			if opts.PrintMode {
				out.WriteFinalPrint()
			}
			return &Result{Skipped: true, Model: noop.Model}, nil
		}
	}

	var snapshotBefore metadata.ContentSnapshot
	if opts.Command != constants.CommandChat {
		snapshotBefore, err = metadata.CreateContentSnapshot(settings.CWD)
		if err != nil {
			return nil, err
		}
	}

	out := output.NewWriter(outputMode(opts.PrintMode))

	_, err = agent.Run(ctx, agent.Options{
		Command:     opts.Command,
		CWD:         settings.CWD,
		ModelID:     settings.ModelID,
		APIKey:      settings.APIKey,
		UserMessage: opts.UserMessage,
		Debug:       settings.Debug,
		Output:      out,
	})
	if err != nil {
		return nil, err
	}

	if opts.PrintMode {
		out.WriteFinalPrint()
	}

	if opts.Command != constants.CommandChat {
		snapshotAfter, err := metadata.CreateContentSnapshot(settings.CWD)
		if err != nil {
			return nil, err
		}

		if snapshotBefore != snapshotAfter {
			head, err := git.GetHead(settings.CWD)
			if err != nil {
				return nil, err
			}
			if err := metadata.WriteLastUpdateMetadata(opts.Command, settings.CWD, settings.ModelID, head); err != nil {
				return nil, fmt.Errorf("write metadata: %w", err)
			}
		}
	}

	return &Result{Model: settings.ModelID}, nil
}

func outputMode(printMode bool) output.Mode {
	if printMode {
		return output.ModePrint
	}
	return output.ModeProgress
}

func shouldCheckUpdateNoop(userMessage string) bool {
	return len(trimSpace(userMessage)) == 0
}

func trimSpace(value string) string {
	start := 0
	end := len(value)
	for start < end && (value[start] == ' ' || value[start] == '\n' || value[start] == '\t' || value[start] == '\r') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\n' || value[end-1] == '\t' || value[end-1] == '\r') {
		end--
	}
	return value[start:end]
}
