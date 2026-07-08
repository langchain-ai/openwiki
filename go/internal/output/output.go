package output

import (
	"fmt"
	"io"
	"os"
)

// Mode controls how agent output is routed.
type Mode int

const (
	ModeProgress Mode = iota
	ModePrint
)

// Writer handles agent event output.
type Writer struct {
	mode       Mode
	progress   io.Writer
	print      io.Writer
	textBuffer []string
}

// NewWriter creates an output writer.
func NewWriter(mode Mode) *Writer {
	return &Writer{
		mode:     mode,
		progress: os.Stderr,
		print:    os.Stdout,
	}
}

// OnText handles assistant text chunks.
func (w *Writer) OnText(text string, source string) {
	if text == "" {
		return
	}

	if source == "subgraph" {
		return
	}

	switch w.mode {
	case ModePrint:
		w.textBuffer = append(w.textBuffer, text)
	case ModeProgress:
		_, _ = fmt.Fprint(w.progress, text)
	}
}

// OnToolStart logs tool invocation to stderr.
func (w *Writer) OnToolStart(name, call string) {
	if w.mode == ModeProgress {
		_, _ = fmt.Fprintf(w.progress, "\n[tool] %s %s\n", name, call)
	}
}

// OnToolEnd logs tool completion to stderr.
func (w *Writer) OnToolEnd(name, status string) {
	if w.mode == ModeProgress {
		_, _ = fmt.Fprintf(w.progress, "[tool done] %s (%s)\n", name, status)
	}
}

// OnDebug logs debug messages to stderr.
func (w *Writer) OnDebug(message string) {
	_, _ = fmt.Fprintf(w.progress, "[debug] %s\n", message)
}

// FinalPrintText returns buffered text for print mode.
func (w *Writer) FinalPrintText() string {
	return joinText(w.textBuffer)
}

// WriteFinalPrint writes final assistant output for print mode.
func (w *Writer) WriteFinalPrint() {
	text := w.FinalPrintText()
	if text == "" {
		return
	}
	_, _ = fmt.Fprintln(w.print, text)
}

func joinText(parts []string) string {
	if len(parts) == 0 {
		return ""
	}
	result := parts[0]
	for i := 1; i < len(parts); i++ {
		result += parts[i]
	}
	return trimSpace(result)
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
