package agent

import (
	"context"
	"fmt"
	"net/http"

	"github.com/langchain-ai/openwiki/go/internal/config"
	"github.com/langchain-ai/openwiki/go/internal/constants"
	"github.com/langchain-ai/openwiki/go/internal/output"
	"github.com/langchain-ai/openwiki/go/internal/prompt"
	"github.com/langchain-ai/openwiki/go/internal/tools"
	"github.com/langchain-ai/openwiki/go/internal/git"
	"github.com/sashabaranov/go-openai"
)

// Options configures an agent run.
type Options struct {
	Command     constants.Command
	CWD         string
	ModelID     string
	APIKey      string
	BaseURL     string
	UserMessage string
	Debug       bool
	Output      *output.Writer
}

// Result describes the outcome of an agent run.
type Result struct {
	Command constants.Command
	Model   string
	Skipped bool
}

// Run executes the OpenWiki agent loop.
func Run(ctx context.Context, opts Options) (*Result, error) {
	runContext, err := git.CreateRunContext(opts.Command, opts.CWD)
	if err != nil {
		return nil, err
	}

	systemPrompt := prompt.SystemPrompt(opts.Command)
	userPrompt := prompt.RuntimeNote(opts.CWD, prompt.UserPrompt(opts.Command, runContext, opts.UserMessage))

	messages := []openai.ChatCompletionMessage{
		{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
		{Role: openai.ChatMessageRoleUser, Content: userPrompt},
	}

	client := newOpenRouterClient(opts.APIKey, opts.BaseURL)
	toolRegistry := tools.NewRegistry(opts.CWD)
	toolDefs := tools.Definitions()

	if opts.Debug && opts.Output != nil {
		opts.Output.OnDebug(fmt.Sprintf("command=%s", opts.Command))
		opts.Output.OnDebug(fmt.Sprintf("model=%s", opts.ModelID))
		opts.Output.OnDebug(fmt.Sprintf("cwd=%s", opts.CWD))
	}

	for iteration := 0; iteration < constants.MaxAgentIterations; iteration++ {
		if opts.Debug && opts.Output != nil {
			opts.Output.OnDebug(fmt.Sprintf("iteration=%d", iteration+1))
		}

		response, err := client.CreateChatCompletion(ctx, openai.ChatCompletionRequest{
			Model:    opts.ModelID,
			Messages: messages,
			Tools:    toolDefs,
		})
		if err != nil {
			return nil, err
		}

		if len(response.Choices) == 0 {
			return nil, fmt.Errorf("OpenRouter returned no choices")
		}

		choice := response.Choices[0]
		assistant := choice.Message

		if assistant.Content != "" && opts.Output != nil {
			opts.Output.OnText(assistant.Content, "main")
		}

		messages = append(messages, assistant)

		if len(assistant.ToolCalls) == 0 {
			return &Result{
				Command: opts.Command,
				Model:   opts.ModelID,
			}, nil
		}

		for _, toolCall := range assistant.ToolCalls {
			if toolCall.Type != openai.ToolTypeFunction || toolCall.Function.Name == "" {
				continue
			}

			if opts.Output != nil {
				opts.Output.OnToolStart(toolCall.Function.Name, toolCall.Function.Arguments)
			}

			result, toolErr := toolRegistry.Execute(toolCall.Function.Name, toolCall.Function.Arguments)
			status := "finished"
			if toolErr != nil {
				status = "error"
				result = toolErr.Error()
			}

			if opts.Output != nil {
				opts.Output.OnToolEnd(toolCall.Function.Name, status)
			}

			messages = append(messages, openai.ChatCompletionMessage{
				Role:       openai.ChatMessageRoleTool,
				Content:    result,
				ToolCallID: toolCall.ID,
				Name:       toolCall.Function.Name,
			})
		}
	}

	return nil, fmt.Errorf("agent exceeded maximum iterations (%d)", constants.MaxAgentIterations)
}

func newOpenRouterClient(apiKey, baseURL string) *openai.Client {
	if baseURL == "" {
		baseURL = constants.OpenRouterBaseURL
	}

	cfg := openai.DefaultConfig(apiKey)
	cfg.BaseURL = baseURL
	cfg.HTTPClient = &http.Client{
		Transport: &openRouterTransport{base: http.DefaultTransport},
	}
	return openai.NewClientWithConfig(cfg)
}

type openRouterTransport struct {
	base http.RoundTripper
}

func (t *openRouterTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.Header.Set("HTTP-Referer", "https://github.com/langchain-ai/openwiki")
	req.Header.Set("X-Title", "OpenWiki")
	return t.base.RoundTrip(req)
}

// LoadSettings is a convenience wrapper for config loading.
func LoadSettings(modelFlag, cwd string) (*config.Settings, error) {
	return config.LoadSettings(modelFlag, cwd)
}
