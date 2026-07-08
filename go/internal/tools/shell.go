package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/langchain-ai/openwiki/go/internal/constants"
)

type executeArgs struct {
	Command string `json:"command"`
}

func (r *Registry) execute(argsJSON string) (string, error) {
	var args executeArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Command) == "" {
		return "", fmt.Errorf("command is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), constants.ShellTimeoutSeconds*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", args.Command)
	cmd.Dir = r.fs.Root

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	output := strings.TrimSpace(stdout.String())
	if stderr.Len() > 0 {
		if output != "" {
			output += "\n"
		}
		output += strings.TrimSpace(stderr.String())
	}

	if len(output) > constants.MaxShellOutputBytes {
		output = output[:constants.MaxShellOutputBytes] + "\n...(output truncated)"
	}

	if err != nil {
		if output == "" {
			return "", err
		}
		return output + "\n(exit error: " + err.Error() + ")", nil
	}

	if output == "" {
		return "(no output)", nil
	}
	return output, nil
}
