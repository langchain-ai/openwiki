package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/langchain-ai/openwiki/go/internal/constants"
	"github.com/langchain-ai/openwiki/go/internal/output"
	"github.com/sashabaranov/go-openai"
)

func TestAgentRunWithMockOpenRouter(t *testing.T) {
	root := t.TempDir()

	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/chat/completions" {
			http.NotFound(w, r)
			return
		}

		body, _ := io.ReadAll(r.Body)
		var req openai.ChatCompletionRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatal(err)
		}

		if calls == 1 {
			_, _ = w.Write([]byte(`{
				"id": "chatcmpl-test",
				"object": "chat.completion",
				"created": 0,
				"model": "test-model",
				"choices": [{
					"index": 0,
					"message": {
						"role": "assistant",
						"content": "",
						"tool_calls": [{
							"id": "call_1",
							"type": "function",
							"function": {
								"name": "write_file",
								"arguments": "{\"path\":\"/openwiki/quickstart.md\",\"content\":\"# Quickstart\"}"
							}
						}]
					},
					"finish_reason": "tool_calls"
				}]
			}`))
			return
		}

		_, _ = w.Write([]byte(`{
			"id": "chatcmpl-test-2",
			"object": "chat.completion",
			"created": 0,
			"model": "test-model",
			"choices": [{
				"index": 0,
				"message": {
					"role": "assistant",
					"content": "Documentation created."
				},
				"finish_reason": "stop"
			}]
		}`))
	}))
	defer server.Close()

	out := output.NewWriter(output.ModePrint)
	result, err := Run(context.Background(), Options{
		Command: constants.CommandInit,
		CWD:     root,
		ModelID: "test-model",
		APIKey:  "test-key",
		BaseURL: server.URL,
		Output:  out,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Model != "test-model" {
		t.Fatalf("unexpected model %s", result.Model)
	}

	written, err := os.ReadFile(filepath.Join(root, "openwiki", "quickstart.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), "# Quickstart") {
		t.Fatalf("expected written file, got %q", string(written))
	}

	if out.FinalPrintText() != "Documentation created." {
		t.Fatalf("unexpected print text %q", out.FinalPrintText())
	}
}
