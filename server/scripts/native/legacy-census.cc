// Public V8 API only. This module is deliberately ABI-specific.
#include <node.h>
#include <node_version.h>
#include <v8-profiler.h>
#include <v8-microtask-queue.h>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>
#ifndef LEGACY_CENSUS_SOURCE_SHA256
#error "Maintained source hash must be supplied by the pinned build"
#endif

namespace legacy_census {
constexpr size_t kMatches = 4000 + 4000 + 2000 + 4000 + 4000 + 4096;
constexpr size_t kCleanup = 32 * 1024 * 1024;
// Array::New(values,n) allocates one fixed backing store and one JSArray.
// Four full-width pointers per element + 64 KiB for headers/alignment/result
// metadata conservatively exceed the pinned V8 allocation (see contract).
constexpr size_t kManagedOutput = kMatches * sizeof(void*) * 4 + 65536;
static_assert(sizeof(void*) == 8, "Only pinned 64-bit runtimes supported");
constexpr const char* kV8 = "12.4.254.21-node.56";
static_assert(NODE_MAJOR_VERSION == 22 && NODE_MINOR_VERSION == 23 &&
              NODE_PATCH_VERSION == 2 && NODE_MODULE_VERSION == 127,
              "Exact Node 22.23.2 headers required");
int64_t Now() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
}
void Refuse(v8::Isolate* isolate, const char* message) {
  isolate->ThrowException(v8::Exception::Error(
      v8::String::NewFromUtf8(isolate, message).ToLocalChecked()));
}
struct Attempt {
  uint64_t predicateVisits = 0, validPredicateVisits = 0, matched = 0;
  int64_t queryStartedAtMs = 0, firstValidAtMs = 0, lastValidAtMs = 0, queryEndedAtMs = 0;
  bool overflow = false, deadlineRefused = false, arrayAllocated = false;
};
thread_local Attempt lastAttempt;
class Predicate final : public v8::QueryObjectPredicate {
 public:
  Predicate(v8::Local<v8::Context> context, v8::Local<v8::Object> marker,
            int64_t deadline)
      : context_(context), marker_(marker), deadline_(deadline) {}
  bool Filter(v8::Local<v8::Object> object) override {
    // QueryObjects does not scope its second-pass predicate callbacks. Keep
    // context/prototype traversal handles local to this visit. Matches are
    // promoted by V8 after this boolean predicate returns.
    v8::HandleScope handles(context_->GetIsolate());
    ++lastAttempt.predicateVisits;
    const auto now = Now();
    if (now >= deadline_) {
      failed_ = true; lastAttempt.deadlineRefused = true; return false;
    }
    ++lastAttempt.validPredicateVisits;
    if (!lastAttempt.firstValidAtMs) lastAttempt.firstValidAtMs = now;
    lastAttempt.lastValidAtMs = now;
    if (lastAttempt.overflow) return false;
    if (object->IsProxy() || object->IsModuleNamespaceObject()) return false;
    v8::Local<v8::Context> creation;
    if (!object->GetCreationContext().ToLocal(&creation) || creation != context_)
      return false;
    v8::Local<v8::Value> cursor = object->GetPrototype();
    for (size_t depth = 0; cursor->IsObject(); ++depth) {
      if (cursor->IsProxy()) return false;
      if (cursor == marker_) {
        if (++lastAttempt.matched > kMatches) {
          lastAttempt.overflow = true;
          return false;
        }
        return true;
      }
      if (depth >= 256) { failed_ = true; return false; }
      cursor = cursor.As<v8::Object>()->GetPrototype();
    }
    return false;
  }
  bool failed_ = false;
 private:
  v8::Local<v8::Context> context_;
  v8::Local<v8::Object> marker_;
  int64_t deadline_;
};
void Collect(const v8::FunctionCallbackInfo<v8::Value>& args) {
  auto* isolate = args.GetIsolate();
  auto context = isolate->GetCurrentContext();
  lastAttempt = Attempt{};
  if (std::strcmp(v8::V8::GetVersion(), kV8) != 0 || args.Length() != 3 ||
      !args[0]->IsObject() || args[0]->IsProxy() || !args[1]->IsNumber() ||
      !args[2]->IsNumber()) {
    Refuse(isolate, "native census ABI or arguments refused"); return;
  }
  const double deadline_value = args[1].As<v8::Number>()->Value();
  const double process_available = args[2].As<v8::Number>()->Value();
  const int64_t now = Now();
  if (!std::isfinite(deadline_value) || std::floor(deadline_value) != deadline_value ||
      deadline_value <= now || deadline_value > now + 40000 ||
      !std::isfinite(process_available) || process_available <= 0 ||
      std::floor(process_available) != process_available ||
      process_available > 9007199254740991.0) {
    Refuse(isolate, "native census deadline or process admission refused"); return;
  }
  const auto deadline = static_cast<int64_t>(deadline_value);
  v8::HeapStatistics before;
  isolate->GetHeapStatistics(&before);
  const double process_required = before.used_heap_size() * 8.0 + kCleanup;
  if (process_available < process_required ||
      before.total_available_size() < kCleanup + kManagedOutput) {
    Refuse(isolate, "native census memory headroom refused"); return;
  }
  // This is the SAME public QueryObjects entry as Inspector: V8 owns its
  // stack marker, typed-array normalization, full GC and exhaustive iteration.
  // Globals hold every match until success or destruction on every refusal.
  std::vector<v8::Global<v8::Object>> matches;
  Predicate predicate(context, args[0].As<v8::Object>(), deadline);
  lastAttempt.queryStartedAtMs = Now();
  isolate->GetHeapProfiler()->QueryObjects(context, &predicate, &matches);
  lastAttempt.queryEndedAtMs = Now();
  if (lastAttempt.overflow) {
    Refuse(isolate, "native census matched output overflow before array"); return;
  }
  if (predicate.failed_ || Now() >= deadline) {
    Refuse(isolate, "native census deadline or topology refused"); return;
  }
  if (matches.size() > kMatches) {
    Refuse(isolate, "native census matched output overflow before array"); return;
  }
  v8::HeapStatistics after;
  isolate->GetHeapStatistics(&after);
  if (after.total_available_size() < kCleanup + kManagedOutput) {
    Refuse(isolate, "native census post-query headroom refused"); return;
  }
  v8::MicrotasksScope microtasks(context, v8::MicrotasksScope::kDoNotRunMicrotasks);
  v8::LocalVector<v8::Value> values(isolate);
  values.reserve(matches.size());
  for (auto& value : matches) values.push_back(value.Get(isolate));
  auto result = v8::Array::New(isolate, values.data(), values.size());
  lastAttempt.arrayAllocated = true;
  if (Now() >= deadline) {
    Refuse(isolate, "native census output deadline refused"); return;
  }
  args.GetReturnValue().Set(result);
}
// Bounded phase diagnostics contain no object handles or application data.
// They distinguish real in-scan expiry from refusal before native work began.
void Diagnostics(const v8::FunctionCallbackInfo<v8::Value>& args) {
  auto* isolate = args.GetIsolate();
  auto context = isolate->GetCurrentContext();
  auto out = v8::Object::New(isolate);
#define NUMBER(name) out->CreateDataProperty(context, v8::String::NewFromUtf8Literal(isolate, #name), v8::Number::New(isolate, lastAttempt.name)).Check()
#define BOOLEAN(name) out->CreateDataProperty(context, v8::String::NewFromUtf8Literal(isolate, #name), v8::Boolean::New(isolate, lastAttempt.name)).Check()
  NUMBER(predicateVisits); NUMBER(validPredicateVisits); NUMBER(matched);
  NUMBER(queryStartedAtMs); NUMBER(firstValidAtMs); NUMBER(lastValidAtMs); NUMBER(queryEndedAtMs);
  BOOLEAN(overflow); BOOLEAN(deadlineRefused); BOOLEAN(arrayAllocated);
#undef NUMBER
#undef BOOLEAN
  args.GetReturnValue().Set(out);
}
void Initialize(v8::Local<v8::Object> exports) {
  NODE_SET_METHOD(exports, "collect", Collect);
  NODE_SET_METHOD(exports, "diagnostics", Diagnostics);
  auto* isolate = exports->GetIsolate();
  auto context = isolate->GetCurrentContext();
  exports->CreateDataProperty(context,
      v8::String::NewFromUtf8Literal(isolate, "sourceSHA256"),
      v8::String::NewFromUtf8Literal(isolate, LEGACY_CENSUS_SOURCE_SHA256)).Check();
  exports->CreateDataProperty(context,
      v8::String::NewFromUtf8Literal(isolate, "maxMatches"),
      v8::Integer::New(isolate, kMatches)).Check();
  exports->CreateDataProperty(context,
      v8::String::NewFromUtf8Literal(isolate, "managedOutputBytes"),
      v8::Integer::New(isolate, kManagedOutput)).Check();
}
NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
}  // namespace legacy_census
