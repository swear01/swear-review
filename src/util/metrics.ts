/** Minimal in-process metrics registry. Prometheus endpoint can be added later. */

export interface Counter {
  inc(labels?: Record<string, string | number>, amount?: number): void;
  render(): string;
}

export interface Histogram {
  observe(value: number, labels?: Record<string, string | number>): void;
  render(): string;
}

type LabelSet = string;

function encodeLabels(labels?: Record<string, string | number>): LabelSet {
  if (!labels || Object.keys(labels).length === 0) return '';
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`);
  return `{${parts.join(',')}}`;
}

class CounterImpl implements Counter {
  private values = new Map<LabelSet, number>();
  constructor(private readonly name: string, private readonly help: string) {}
  inc(labels?: Record<string, string | number>, amount = 1): void {
    const key = encodeLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }
  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    for (const [labels, value] of this.values) {
      out += `${this.name}${labels} ${value}\n`;
    }
    return out;
  }
}

class HistogramImpl implements Histogram {
  private buckets = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];
  private counts = new Map<LabelSet, number[]>();
  private sums = new Map<LabelSet, number>();
  constructor(private readonly name: string, private readonly help: string) {}
  observe(value: number, labels?: Record<string, string | number>): void {
    const key = encodeLabels(labels);
    const counts = this.counts.get(key) ?? new Array(this.buckets.length + 1).fill(0);
    let bucket = this.buckets.length;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        bucket = i;
        break;
      }
    }
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    this.counts.set(key, counts);
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
  }
  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    for (const [labels, counts] of this.counts) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += counts[i] ?? 0;
        out += `${this.name}_bucket${labels.replace('}', `,le="${this.buckets[i]}"}`)} ${cumulative}\n`;
      }
      cumulative += counts[this.buckets.length] ?? 0;
      out += `${this.name}_bucket${labels.replace('}', `,le="+Inf"}`)} ${cumulative}\n`;
      out += `${this.name}_sum${labels} ${this.sums.get(labels) ?? 0}\n`;
      out += `${this.name}_count${labels} ${cumulative}\n`;
    }
    return out;
  }
}

export class Metrics {
  readonly reviewsTotal: Counter;
  readonly reviewsSuccess: Counter;
  readonly reviewsFailed: Counter;
  readonly reviewsCancelled: Counter;
  readonly reviewsStale: Counter;
  readonly reviewDurationSeconds: Histogram;
  readonly findingsTotal: Counter;
  readonly ocrProcessFailures: Counter;
  readonly githubPublishFailures: Counter;
  readonly jobsSuperseded: Counter;
  readonly dedupSkipped: Counter;
  readonly webhooksReceived: Counter;
  readonly webhookSignatureFailures: Counter;
  readonly commandsReceived: Counter;
  readonly commandsDenied: Counter;

  constructor() {
    this.reviewsTotal = new CounterImpl('swear_reviews_total', 'Review jobs started');
    this.reviewsSuccess = new CounterImpl('swear_reviews_success', 'Review jobs completed successfully');
    this.reviewsFailed = new CounterImpl('swear_reviews_failed', 'Review jobs failed');
    this.reviewsCancelled = new CounterImpl('swear_reviews_cancelled', 'Review jobs cancelled (superseded/stale)');
    this.reviewsStale = new CounterImpl('swear_reviews_stale', 'Review results discarded due to stale head');
    this.reviewDurationSeconds = new HistogramImpl('swear_review_duration_seconds', 'Review execution duration');
    this.findingsTotal = new CounterImpl('swear_findings_total', 'Findings produced by OCR');
    this.ocrProcessFailures = new CounterImpl('swear_ocr_process_failures', 'OCR process failures');
    this.githubPublishFailures = new CounterImpl('swear_github_publish_failures', 'GitHub publication failures');
    this.jobsSuperseded = new CounterImpl('swear_jobs_superseded', 'Jobs superseded by newer events');
    this.dedupSkipped = new CounterImpl('swear_dedup_skipped', 'Findings skipped by dedup');
    this.webhooksReceived = new CounterImpl('swear_webhooks_received', 'Webhooks received');
    this.webhookSignatureFailures = new CounterImpl('swear_webhook_signature_failures', 'Webhook signature validation failures');
    this.commandsReceived = new CounterImpl('swear_commands_received', 'Manual commands received');
    this.commandsDenied = new CounterImpl('swear_commands_denied', 'Manual commands denied (permission)');
  }

  render(): string {
    const out: string[] = [];
    for (const counter of [
      this.reviewsTotal, this.reviewsSuccess, this.reviewsFailed, this.reviewsCancelled,
      this.reviewsStale, this.findingsTotal, this.ocrProcessFailures,
      this.githubPublishFailures, this.jobsSuperseded, this.dedupSkipped,
      this.webhooksReceived, this.webhookSignatureFailures,
      this.commandsReceived, this.commandsDenied,
    ]) {
      out.push(counter.render());
    }
    out.push(this.reviewDurationSeconds.render());
    return out.join('\n');
  }
}
