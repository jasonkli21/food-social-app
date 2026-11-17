package goodfork

import "regexp"

var negativePreference = regexp.MustCompile(`(?i)\b(?:not|no|avoid|without|except)\s+(?:\w+\s+)?(?:italian|japanese|mexican|korean|vietnamese|thai|indian|chinese|french|ethiopian|greek|vegetarian|vegan|halal|gluten)\b`)

func hasNegativePreference(prompt string) bool { return negativePreference.MatchString(prompt) }
