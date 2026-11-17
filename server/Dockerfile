FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /goodfork ./cmd/goodfork

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /goodfork /goodfork
EXPOSE 8080
ENTRYPOINT ["/goodfork"]
CMD ["serve"]
