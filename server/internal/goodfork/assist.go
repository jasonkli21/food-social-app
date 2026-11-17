package goodfork

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
)

type diningSignals struct {
	Cuisines []string `json:"cuisines"`
	Diets    []string `json:"diets"`
	Price    int      `json:"priceTier,omitempty"`
}

type diningChoice struct {
	Cuisine string `json:"cuisine"`
	Diet    string `json:"diet"`
}

type replySignals struct {
	Topics    []string `json:"topics"`
	Sentiment string   `json:"sentiment"`
	Tone      string   `json:"tone"`
}

type replyChoice struct {
	Topic   string `json:"topic"`
	Opening string `json:"opening"`
	Close   string `json:"close"`
}

type diningProvider interface {
	InterpretDiningIntent(context.Context, diningSignals) (diningChoice, error)
}

type replyProvider interface {
	DraftOwnerReply(context.Context, replySignals) (replyChoice, error)
}

type localAssist struct{}

func (localAssist) InterpretDiningIntent(_ context.Context, signals diningSignals) (diningChoice, error) {
	result := diningChoice{}
	if len(signals.Cuisines) > 0 {
		result.Cuisine = signals.Cuisines[0]
	}
	if len(signals.Diets) > 0 {
		result.Diet = signals.Diets[0]
	}
	return result, nil
}

func (localAssist) DraftOwnerReply(_ context.Context, signals replySignals) (replyChoice, error) {
	opening, close := "thanks", "none"
	if signals.Tone == "warm" {
		opening = "appreciate"
	}
	if signals.Sentiment == "positive" {
		close = "welcome"
	}
	return replyChoice{Topic: signals.Topics[0], Opening: opening, Close: close}, nil
}

func matchingLabels(words string, rules [][2]string) ([]string, string) {
	found := []string{}
	for _, rule := range rules {
		token := " " + rule[0] + " "
		if strings.Contains(words, token) {
			if !slices.Contains(found, rule[1]) {
				found = append(found, rule[1])
			}
			words = strings.ReplaceAll(words, token, " ")
		}
	}
	return found, words
}

var recognizedCuisines = [][2]string{
	{"japanese", "Japanese"}, {"italian", "Italian"}, {"mexican", "Mexican"}, {"korean", "Korean"},
	{"vietnamese", "Vietnamese"}, {"thai", "Thai"}, {"indian", "Indian"}, {"chinese", "Chinese"},
	{"french", "French"}, {"ethiopian", "Ethiopian"}, {"greek", "Greek"},
}
var recognizedDiets = [][2]string{
	{"gluten free", "Gluten-free options"}, {"vegetarian", "Vegetarian"}, {"vegan", "Vegan"}, {"halal", "Halal"},
}
var priceAmount = regexp.MustCompile(`(?i)\b(?:under|below|less than|up to)\s*\$?\d+(?:\.\d+)?(?:\s*dollars)?\b`)
var diningFillers = strings.Fields("a an and are find for get give good have i im in is it like looking me my near nearby need of on options or place please restaurant restaurants should some something the to try want what where with would around any cheap inexpensive affordable budget moderately priced upscale dinner lunch tonight now eat")

func localIntent(prompt, area string) (diningSignals, string) {
	words := " " + strings.Join(strings.FieldsFunc(strings.ToLower(priceAmount.ReplaceAllString(prompt, " ")), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	}), " ") + " "
	if area != "" {
		words = strings.ReplaceAll(words, " "+strings.Join(searchWords(area), " ")+" ", " ")
	}
	diets, words := matchingLabels(words, recognizedDiets)
	cuisines, words := matchingLabels(words, recognizedCuisines)
	price := 0
	switch {
	case strings.Contains(words, " cheap "), strings.Contains(words, " budget "), strings.Contains(words, " inexpensive "):
		price = 1
	case strings.Contains(words, " affordable "), strings.Contains(words, " moderately priced "):
		price = 2
	case strings.Contains(words, " upscale "):
		price = 3
	}
	remaining := []string{}
	for _, word := range strings.Fields(words) {
		if !slices.Contains(diningFillers, word) {
			remaining = append(remaining, word)
		}
	}
	return diningSignals{cuisines, diets, price}, strings.Join(remaining, " ")
}

func (a *API) mentionedArea(ctx context.Context, prompt string) (string, error) {
	var area string
	// Only a matching public directory label becomes a filter. Literal user text stays in this process.
	err := a.db.QueryRow(ctx, `
		SELECT coalesce((SELECT area FROM places WHERE status='published' AND char_length(area)>=3
		   AND strpos(' '||lower($1::text)||' ',' '||lower(area)||' ')>0
		   ORDER BY char_length(area) DESC,area LIMIT 1),'')`, prompt).Scan(&area)
	return area, err
}

type recommendation struct {
	Place  json.RawMessage `json:"place"`
	Reason string          `json:"reason"`
}

func (a *API) suggestPlaces(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Prompt      string          `json:"prompt"`
		Filters     directoryFilter `json:"filters"`
		AllowRemote bool            `json:"allowRemote"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	prompt, err := tidy(body.Prompt, 2, 160, "Dining request")
	if err != nil {
		return err
	}
	if err := body.Filters.validate(); err != nil {
		return err
	}
	ctx := r.Context()
	if err := a.budget(ctx, "ai_local"); err != nil {
		return err
	}
	f := body.Filters
	if hasNegativePreference(prompt) {
		return send(w, http.StatusOK, map[string]any{"filters": f, "suggestions": []recommendation{}, "outcome": "local",
			"note": "This request contains an exclusion. Choose the cuisines or dietary tags you want in the editable filters."})
	}
	if strings.Contains(strings.ToLower(prompt), "open now") {
		f.OpenNow = true
	}
	area, err := a.mentionedArea(ctx, strings.Join(strings.Fields(strings.ToLower(prompt)), " "))
	if err != nil {
		return err
	}
	if f.Area == "" {
		f.Area = area
	}
	signals, query := localIntent(prompt, area)
	queryWords := []string{}
	for _, word := range strings.Fields(query) {
		if word != "open" {
			queryWords = append(queryWords, word)
		}
	}
	query = strings.Join(queryWords, " ")
	local, _ := (localAssist{}).InterpretDiningIntent(ctx, signals)
	choice := local
	outcome := "local"
	if body.AllowRemote && a.config.DiningProvider != nil {
		started := time.Now()
		outcome = "fallback"
		if err := a.budget(ctx, "ai_remote"); err == nil {
			proposed, err := a.config.DiningProvider.InterpretDiningIntent(ctx, signals)
			if err == nil && validDiningChoice(signals, proposed) {
				choice = proposed
				outcome = "provider"
			}
		}
		a.log.Info("assist completed", "operation", "dining", "outcome", outcome, "elapsed_ms", time.Since(started).Milliseconds())
	}
	if f.Q == "" {
		words := []rune(query)
		f.Q = string(words[:min(120, len(words))])
	}
	if f.Diet == "" {
		f.Diet = choice.Diet
	}
	if f.Cuisine == "" {
		f.Cuisine = choice.Cuisine
	}
	if f.Price == 0 {
		f.Price = signals.Price
	}
	if err := f.validate(); err != nil {
		return err
	}
	results, err := a.findPlaces(ctx, viewer, f, 5, 0)
	if err != nil {
		return err
	}
	items := make([]recommendation, 0, len(results))
	for _, item := range results {
		var facts struct {
			Area      string `json:"area"`
			Cuisine   string `json:"cuisine"`
			DishMatch *struct {
				Dish string `json:"dish"`
			} `json:"dishMatch"`
		}
		if err := json.Unmarshal(item, &facts); err != nil {
			return err
		}
		reason := "Listed as " + facts.Cuisine
		if f.Diet != "" {
			reason += " with a " + f.Diet + " listing tag"
		}
		if f.Area != "" && facts.Area != "" {
			reason += " in " + facts.Area
		}
		if facts.DishMatch != nil {
			reason = "A diner mentioned " + facts.DishMatch.Dish
		}
		items = append(items, recommendation{item, reason})
	}
	note := ""
	if len(items) == 0 {
		note = "No restaurants match these filters. Try changing an area, dish, or price tier."
	} else if priceAmount.MatchString(prompt) {
		note = "Exact prices are unavailable. You can narrow the list using price tiers."
	} else if (f.Diet != "" && len(signals.Diets) > 1) || (f.Cuisine != "" && len(signals.Cuisines) > 1) {
		note = "Check the selected filters. You can change the cuisine or dietary option before searching again."
	}
	return send(w, http.StatusOK, map[string]any{"filters": f, "suggestions": items, "note": note, "outcome": outcome})
}

func validDiningChoice(signals diningSignals, choice diningChoice) bool {
	return ((len(signals.Cuisines) == 0 && choice.Cuisine == "") || slices.Contains(signals.Cuisines, choice.Cuisine)) &&
		((len(signals.Diets) == 0 && choice.Diet == "") || slices.Contains(signals.Diets, choice.Diet))
}

func replyTopics(review string) []string {
	lower := strings.ToLower(review)
	matches := []string{}
	for _, rule := range []struct {
		name string
		cues []string
	}{
		{"wait", []string{"wait", "line", "slow", "queue"}},
		{"service", []string{"server", "staff", "service", "friendly"}},
		{"food", []string{"dish", "food", "delicious", "flavor", "cold", "soup", "ramen", "taco", "pizza"}},
		{"value", []string{"price", "value", "expensive", "cost"}},
		{"room", []string{"room", "loud", "cozy", "atmosphere", "music"}},
	} {
		for _, cue := range rule.cues {
			if strings.Contains(lower, cue) {
				matches = append(matches, rule.name)
				break
			}
		}
	}
	if len(matches) == 0 {
		matches = append(matches, "visit")
	}
	return matches
}

func validReplyChoice(signals replySignals, choice replyChoice) bool {
	return slices.Contains(signals.Topics, choice.Topic) &&
		(choice.Opening == "thanks" || choice.Opening == "appreciate") &&
		(choice.Close == "none" || (choice.Close == "welcome" && signals.Sentiment == "positive"))
}

func (a *API) suggestReply(w http.ResponseWriter, r *http.Request, viewer string) error {
	var body struct {
		Tone        string `json:"tone"`
		AllowRemote bool   `json:"allowRemote"`
	}
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if body.Tone != "warm" && body.Tone != "concise" {
		return invalid("Choose a reply tone.")
	}
	ctx, id := r.Context(), r.PathValue("id")
	var review, version string
	var score float64
	err := a.db.QueryRow(ctx, "SELECT p.text,p.score::float8,p.revision::text"+eligibleOwnerReview, id, viewer).Scan(&review, &score, &version)
	if err != nil {
		return err
	}
	if err := a.budget(ctx, "ai_local"); err != nil {
		return err
	}
	if err := a.limit(ctx, "reply_assist:"+viewer, 20, time.Hour); err != nil {
		return err
	}
	sentiment := "mixed"
	if score >= 8 {
		sentiment = "positive"
	} else if score <= 5 {
		sentiment = "concern"
	}
	signals := replySignals{replyTopics(review), sentiment, body.Tone}
	choice, _ := (localAssist{}).DraftOwnerReply(ctx, signals)
	outcome := "local"
	if body.AllowRemote && a.config.ReplyProvider != nil {
		started := time.Now()
		outcome = "fallback"
		if err := a.budget(ctx, "ai_remote"); err == nil {
			proposed, err := a.config.ReplyProvider.DraftOwnerReply(ctx, signals)
			if err == nil && validReplyChoice(signals, proposed) {
				choice = proposed
				outcome = "provider"
			}
		}
		a.log.Info("assist completed", "operation", "reply", "outcome", outcome, "elapsed_ms", time.Since(started).Milliseconds())
	}
	var current string
	if err := a.db.QueryRow(ctx, "SELECT p.revision::text"+eligibleOwnerReview, id, viewer).Scan(&current); err != nil {
		return err
	}
	if current != version {
		return conflict("The review changed. Reload it before drafting a response.")
	}
	opening := "Thank you for sharing your feedback."
	if choice.Opening == "appreciate" {
		opening = "We appreciate you taking the time to tell us about your visit."
	}
	topics := map[string]string{"wait": "wait times", "service": "service", "food": "the food", "value": "value", "room": "the dining room", "visit": "the experience"}
	focus := " Your feedback about " + topics[choice.Topic] + " is helpful to our team."
	if choice.Topic == "visit" {
		focus = ""
	}
	close := ""
	if choice.Close == "welcome" {
		close = " We hope to see you again."
	}
	return send(w, http.StatusOK, map[string]string{"draft": opening + focus + close, "outcome": outcome})
}
