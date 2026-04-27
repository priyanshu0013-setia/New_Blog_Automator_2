import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  useCreateArticle,
  useCreateArticlesBatch,
  getGetActiveArticlesQueryKey,
  getGetDashboardStatsQueryKey,
  getListArticlesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Upload, Download, Plus, Trash2, AlertCircle, CheckCircle, Link2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const articleSchema = z.object({
  topic: z.string().min(3, "Topic must be at least 3 characters"),
  primaryKeyword: z.string().min(2, "Primary keyword is required"),
  secondaryKeywords: z.string().optional(),
  targetAudience: z.string().optional(),
  tone: z.string().optional(),
  wordCountTarget: z.coerce.number().min(300).max(10000).default(1500),
  createdBy: z.string().optional(),
});

type ArticleForm = z.infer<typeof articleSchema>;

type BatchRow = {
  id: string;
  topic: string;
  primaryKeyword: string;
  secondaryKeywords: string;
  targetAudience: string;
  tone: string;
  wordCountTarget: string;
};

const MAX_REFERENCE_INPUT_LENGTH = 12000;
const ACCEPTED_REFERENCE_FILE_TYPES =
  ".txt,.md,.csv,.html,.json,text/plain,text/csv,text/markdown,text/html,application/json";
const ACCEPTED_REFERENCE_FILE_LABEL = ".txt, .md, .csv, .html, .json";

export default function NewArticle() {
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [referenceLink, setReferenceLink] = useState("");
  const [referenceFileName, setReferenceFileName] = useState<string | null>(null);
  const [referenceFileContent, setReferenceFileContent] = useState<string | null>(null);
  const [referenceUploadStatus, setReferenceUploadStatus] = useState("");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const referenceFileInputRef = useRef<HTMLInputElement>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetActiveArticlesQueryKey() });
    qc.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
    qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
  };

  const { register, handleSubmit, formState: { errors }, reset } = useForm<ArticleForm>({
    resolver: zodResolver(articleSchema),
    defaultValues: { wordCountTarget: 1500 },
  });

  const createArticle = useCreateArticle({
    mutation: {
      onSuccess: (article) => {
        toast({ title: "Article queued!", description: `Pipeline started for "${article.topic}"` });
        invalidate();
        reset();
        setReferenceLink("");
        setReferenceFileName(null);
        setReferenceFileContent(null);
        setReferenceUploadStatus("");
        setLocation(`/article/${article.id}`);
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to create article. Please try again.", variant: "destructive" });
      },
    },
  });

  const createBatch = useCreateArticlesBatch({
    mutation: {
      onSuccess: (articles) => {
        toast({ title: `${articles.length} articles queued!`, description: "Pipeline started for all articles." });
        invalidate();
        setLocation("/status");
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to create batch. Please try again.", variant: "destructive" });
      },
    },
  });

  const onSingleSubmit = (data: ArticleForm) => {
    const normalizedLink = referenceLink.trim();
    let referenceInput: string | undefined;
    const linkPart = normalizedLink ? `Reference link: ${normalizedLink}` : "";
    const docHeader = `Reference document (${referenceFileName || "uploaded file"}):\n`;
    const separator = normalizedLink && referenceFileContent ? "\n\n" : "";

    if (normalizedLink && referenceFileContent) {
      const availableForDoc = MAX_REFERENCE_INPUT_LENGTH - (linkPart.length + separator.length + docHeader.length);
      const docPart = availableForDoc > 0 ? referenceFileContent.slice(0, availableForDoc) : "";
      referenceInput = `${linkPart}${separator}${docHeader}${docPart}`.slice(0, MAX_REFERENCE_INPUT_LENGTH);
    } else if (normalizedLink) {
      referenceInput = linkPart.slice(0, MAX_REFERENCE_INPUT_LENGTH);
    } else if (referenceFileContent) {
      const availableForDoc = MAX_REFERENCE_INPUT_LENGTH - docHeader.length;
      const docPart = availableForDoc > 0 ? referenceFileContent.slice(0, availableForDoc) : "";
      referenceInput = `${docHeader}${docPart}`.slice(0, MAX_REFERENCE_INPUT_LENGTH);
    }

    createArticle.mutate({ data: {
      topic: data.topic,
      primaryKeyword: data.primaryKeyword,
      secondaryKeywords: data.secondaryKeywords || undefined,
      targetAudience: data.targetAudience || undefined,
      tone: data.tone || undefined,
      referenceInput,
      wordCountTarget: data.wordCountTarget,
      createdBy: data.createdBy || undefined,
    }});
  };

  // Batch mode
  const [batchRows, setBatchRows] = useState<BatchRow[]>([
    { id: "1", topic: "", primaryKeyword: "", secondaryKeywords: "", targetAudience: "", tone: "", wordCountTarget: "1500" },
  ]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleReferenceFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = (await file.text()).trim();
      if (!text) {
        toast({
          title: "File is empty",
          description: "Upload a document that contains readable text or provide a link.",
          variant: "destructive",
        });
        setReferenceFileName(null);
        setReferenceFileContent(null);
        setReferenceUploadStatus("Upload failed: file is empty.");
        return;
      }

      const trimmed = text.slice(0, MAX_REFERENCE_INPUT_LENGTH);
      if (text.length > MAX_REFERENCE_INPUT_LENGTH) {
        toast({
          title: "Document trimmed",
          description: "Reference document was long, so only the first part was included.",
        });
      }
      setReferenceFileName(file.name);
      setReferenceFileContent(trimmed);
      setReferenceUploadStatus(`Uploaded reference document: ${file.name}`);
    } catch {
      toast({
        title: "Unsupported file",
        description: "Could not read this document. Please upload a text-based file or provide a link.",
        variant: "destructive",
      });
      setReferenceFileName(null);
      setReferenceFileContent(null);
      setReferenceUploadStatus("Upload failed: unsupported file.");
    }
  };

  const addRow = () => {
    if (batchRows.length >= 3) {
      toast({ title: "Max 3 articles per batch", variant: "destructive" });
      return;
    }
    setBatchRows((r) => [...r, { id: Date.now().toString(), topic: "", primaryKeyword: "", secondaryKeywords: "", targetAudience: "", tone: "", wordCountTarget: "1500" }]);
  };

  const removeRow = (id: string) => {
    setBatchRows((r) => r.filter((row) => row.id !== id));
  };

  const updateRow = (id: string, field: keyof BatchRow, value: string) => {
    setBatchRows((r) => r.map((row) => row.id === id ? { ...row, [field]: value } : row));
  };

  const downloadTemplate = () => {
    const csv = "topic,primaryKeyword,secondaryKeywords,targetAudience,tone,wordCountTarget\nExample Topic,example keyword,keyword2 keyword3,Small business owners,Authoritative,1500\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "article_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split("\n").filter((l) => l.trim());
      const dataLines = lines.slice(1);
      const rows: BatchRow[] = dataLines.slice(0, 3).map((line, i) => {
        const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        return {
          id: String(i + 1),
          topic: cols[0] || "",
          primaryKeyword: cols[1] || "",
          secondaryKeywords: cols[2] || "",
          targetAudience: cols[3] || "",
          tone: cols[4] || "",
          wordCountTarget: cols[5] || "1500",
        };
      });
      if (rows.length > 0) setBatchRows(rows);
    };
    reader.readAsText(file);
  };

  const submitBatch = () => {
    const valid = batchRows.filter((r) => r.topic.trim() && r.primaryKeyword.trim());
    if (valid.length === 0) {
      toast({ title: "No valid rows", description: "Add at least one article with a topic and keyword.", variant: "destructive" });
      return;
    }
    createBatch.mutate({
      data: {
        articles: valid.map((r) => ({
          topic: r.topic,
          primaryKeyword: r.primaryKeyword,
          secondaryKeywords: r.secondaryKeywords || undefined,
          targetAudience: r.targetAudience || undefined,
          tone: r.tone || undefined,
          wordCountTarget: parseInt(r.wordCountTarget) || 1500,
        })),
      },
    });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">New Article</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure your article and start the automated pipeline</p>
      </div>

      {/* Mode toggle */}
      <div className="flex bg-muted rounded-lg p-1 w-fit">
        <button
          data-testid="button-mode-single"
          onClick={() => setMode("single")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${mode === "single" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          <span className="flex items-center gap-2"><FileText className="h-4 w-4" /> Single Article</span>
        </button>
        <button
          data-testid="button-mode-batch"
          onClick={() => setMode("batch")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${mode === "batch" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          <span className="flex items-center gap-2"><Upload className="h-4 w-4" /> Batch Upload</span>
        </button>
      </div>

      {mode === "single" ? (
        <form onSubmit={handleSubmit(onSingleSubmit)} className="space-y-5">
          <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
            <FormField label="Topic *" error={errors.topic?.message}>
              <input
                data-testid="input-topic"
                {...register("topic")}
                placeholder="e.g. Best project management tools for remote teams"
                className="input-base"
              />
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Primary Keyword *" error={errors.primaryKeyword?.message}>
                <input
                  data-testid="input-primary-keyword"
                  {...register("primaryKeyword")}
                  placeholder="e.g. project management tools"
                  className="input-base"
                />
              </FormField>

              <FormField label="Secondary Keywords" error={errors.secondaryKeywords?.message}>
                <input
                  data-testid="input-secondary-keywords"
                  {...register("secondaryKeywords")}
                  placeholder="e.g. team collaboration, task management"
                  className="input-base"
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Target Audience" error={errors.targetAudience?.message}>
                <input
                  data-testid="input-target-audience"
                  {...register("targetAudience")}
                  placeholder="e.g. Remote team managers"
                  className="input-base"
                />
              </FormField>

              <FormField label="Word Count" error={errors.wordCountTarget?.message}>
                <input
                  data-testid="input-word-count"
                  type="number"
                  {...register("wordCountTarget")}
                  className="input-base"
                />
              </FormField>
            </div>

            <FormField label="Tone (optional)" error={errors.tone?.message}>
              <input
                data-testid="input-tone"
                {...register("tone")}
                placeholder="e.g. Formal, Authoritative, Conversational"
                className="input-base"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Free-text. Examples: "Formal", "Authoritative expert", "Friendly and conversational", "Technical, precise". Leave blank for default formal voice.
              </p>
            </FormField>

            <FormField label="Reference Input (document upload or link)">
              <div className="space-y-3">
                <div className="relative">
                  <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <input
                    data-testid="input-reference-link"
                    value={referenceLink}
                    onChange={(e) => setReferenceLink(e.target.value)}
                    placeholder="https://example.com/reference-source"
                    className="input-base pl-9"
                  />
                </div>
                <div className="border border-card-border rounded-md p-3 bg-muted/20 flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground truncate">
                    {referenceFileName
                      ? `Uploaded: ${referenceFileName}`
                      : `Upload a reference document (${ACCEPTED_REFERENCE_FILE_LABEL})`}
                  </div>
                  <div className="flex items-center gap-2">
                    {referenceFileName && (
                      <button
                        type="button"
                        onClick={() => {
                          setReferenceFileName(null);
                          setReferenceFileContent(null);
                          setReferenceUploadStatus("Reference document cleared.");
                          if (referenceFileInputRef.current) referenceFileInputRef.current.value = "";
                        }}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => referenceFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Upload
                    </button>
                  </div>
                </div>
                <input
                  ref={referenceFileInputRef}
                  type="file"
                  accept={ACCEPTED_REFERENCE_FILE_TYPES}
                  className="hidden"
                  onChange={handleReferenceFileUpload}
                />
                <p className="sr-only" aria-live="polite">
                  {referenceUploadStatus}
                </p>
                <p className="text-xs text-muted-foreground">
                  Provide a link, upload a text-based document, or both. Manual text paste is not required.
                </p>
              </div>
            </FormField>

            <FormField label="Created By" error={errors.createdBy?.message}>
              <input
                data-testid="input-created-by"
                {...register("createdBy")}
                placeholder="Your name or email (optional)"
                className="input-base"
              />
            </FormField>
          </div>

          <InfoBox />

          <button
            data-testid="button-generate"
            type="submit"
            disabled={createArticle.isPending}
            className="w-full bg-primary text-primary-foreground py-2.5 rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {createArticle.isPending ? (
              <>
                <div className="h-4 w-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                Starting pipeline...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" />
                Generate Article
              </>
            )}
          </button>
        </form>
      ) : (
        <div className="space-y-5">
          {/* CSV Upload zone */}
          <div
            className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm font-medium text-foreground">Drop CSV here or click to upload</p>
            <p className="text-xs text-muted-foreground mt-1">Supports up to 3 articles per batch</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleCSVUpload}
            />
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={downloadTemplate}
              className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
            >
              <Download className="h-3.5 w-3.5" />
              Download CSV template
            </button>
            <button
              onClick={addRow}
              disabled={batchRows.length >= 3}
              className="inline-flex items-center gap-2 text-sm text-primary hover:underline disabled:opacity-40 disabled:no-underline"
            >
              <Plus className="h-3.5 w-3.5" />
              Add row
            </button>
          </div>

          <div className="space-y-3">
            {batchRows.map((row, idx) => (
              <div key={row.id} className="bg-card border border-card-border rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Article {idx + 1}</span>
                  {batchRows.length > 1 && (
                    <button onClick={() => removeRow(row.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    placeholder="Topic *"
                    value={row.topic}
                    onChange={(e) => updateRow(row.id, "topic", e.target.value)}
                    className="input-base col-span-2"
                  />
                  <input
                    placeholder="Primary keyword *"
                    value={row.primaryKeyword}
                    onChange={(e) => updateRow(row.id, "primaryKeyword", e.target.value)}
                    className="input-base"
                  />
                  <input
                    placeholder="Secondary keywords"
                    value={row.secondaryKeywords}
                    onChange={(e) => updateRow(row.id, "secondaryKeywords", e.target.value)}
                    className="input-base"
                  />
                  <input
                    placeholder="Target audience"
                    value={row.targetAudience}
                    onChange={(e) => updateRow(row.id, "targetAudience", e.target.value)}
                    className="input-base"
                  />
                  <input
                    placeholder="Tone (e.g. Formal)"
                    value={row.tone}
                    onChange={(e) => updateRow(row.id, "tone", e.target.value)}
                    className="input-base"
                  />
                  <input
                    placeholder="Word count"
                    type="number"
                    value={row.wordCountTarget}
                    onChange={(e) => updateRow(row.id, "wordCountTarget", e.target.value)}
                    className="input-base"
                  />
                </div>
              </div>
            ))}
          </div>

          <InfoBox />

          <button
            data-testid="button-generate-batch"
            onClick={submitBatch}
            disabled={createBatch.isPending}
            className="w-full bg-primary text-primary-foreground py-2.5 rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {createBatch.isPending ? (
              <>
                <div className="h-4 w-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                Starting pipelines...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" />
                Generate {batchRows.filter((r) => r.topic && r.primaryKeyword).length} Articles
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function FormField({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function InfoBox() {
  return (
    <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-lg p-4 flex gap-3">
      <AlertCircle className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
      <div className="text-xs text-blue-800 dark:text-blue-300 space-y-1">
        <p className="font-medium">What happens next</p>
        <p>The pipeline runs: Collate Inputs → Deep Research → Web-search Source Gathering → Claude Draft (citations constrained to verified sources) → Citation Verification → ZeroGPT Humanize → ZeroGPT AI Score → Keyword & FAQ Checks → SEO Metadata → Google Docs.</p>
      </div>
    </div>
  );
}
