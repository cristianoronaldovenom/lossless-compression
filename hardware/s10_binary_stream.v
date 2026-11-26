// Binary expansion with a 64-bit packed input and 512-bit output.
// One packet = one palette block. Every nonfinal input beat decodes 80 bytes.
// Final input beat decodes 1..80 bytes. The host supplies resolved symbols.
// Keep masks identify valid output bytes; error is sticky until reset.
// The register stage isolates expansion from the fixed-offset gearbox.
module s10_binary_stream(
    input wire clk, input wire reset,
    input wire in_valid, output wire in_ready,
    input wire [63:0] in_indices, input wire [9:0] symbol0, symbol1,
    input wire [6:0] in_bytes, input wire in_last,
    output wire out_valid, input wire out_ready,
    output wire [511:0] out_data, output wire [63:0] out_keep,
    output wire out_last, output reg error
);
    wire [639:0] expanded;
    genvar i;
    generate for(i=0;i<64;i=i+1) begin: lane
        assign expanded[i*10+:10] = in_indices[i] ? symbol1 : symbol0;
    end endgenerate

    reg stage_valid, stage_last;
    reg [639:0] stage_data;
    reg [6:0] stage_bytes;
    reg [1151:0] buffer;
    reg [7:0] used;
    reg final_pending;
    assign out_valid = (used >= 64) || (final_pending && used != 0);
    assign out_last = final_pending && used <= 64 && used != 0;
    assign out_data = buffer[511:0];
    assign out_keep = used >= 64 ? {64{1'b1}} : ((64'b1 << used)-1'b1);
    wire pop = out_valid && out_ready;
    wire [7:0] after_pop = pop ? (used > 64 ? used-64 : 0) : used;
    wire [1151:0] shifted = pop ? (buffer >> 512) : buffer;
    wire accept = stage_valid && !final_pending && after_pop <= 64;
    assign in_ready = !stage_valid || accept;
    wire take = in_valid && in_ready;

    // Before a final beat, occupancy is a multiple of 16. Final partial
    // data is never followed by another append until that packet drains.
    // Mask only the unused bytes on the final stage beat; output keep also
    // marks the final bytes and consumers must honor it.
    wire [639:0] masked;
    genvar k;
    generate for(k=0;k<80;k=k+1) begin: mask_byte
        assign masked[k*8+:8] = k < stage_bytes ? stage_data[k*8+:8] : 8'b0;
    end endgenerate
    reg [1151:0] appended;
    always @* begin
        case (after_pop)
          0:  appended = {{512{1'b0}},masked};
          16: appended = (shifted & {{1024{1'b0}},{128{1'b1}}}) | ({{512{1'b0}},masked} << 128);
          32: appended = (shifted & {{896{1'b0}},{256{1'b1}}}) | ({{512{1'b0}},masked} << 256);
          48: appended = (shifted & {{768{1'b0}},{384{1'b1}}}) | ({{512{1'b0}},masked} << 384);
          64: appended = (shifted & {{640{1'b0}},{512{1'b1}}}) | ({{512{1'b0}},masked} << 512);
          default: appended = shifted;
        endcase
    end
    // Validate original-symbol padding and all unused compressed bits on
    // the final beat. Count is ceil(in_bytes*8/10), 1..64 for legal input.
    wire [9:0] valid_bits = {3'b0,in_bytes} << 3;
    wire [9:0] symbol_count = (valid_bits + 10'd9) / 10'd10;
    wire [9:0] last_valid = valid_bits - (symbol_count-1'b1)*10'd10;
    wire [9:0] last_symbol = in_indices[(symbol_count-1'b1)&10'd63] ? symbol1 : symbol0;
    wire bad = in_bytes == 0 || in_bytes > 80 || (!in_last && in_bytes != 80) ||
               symbol0 == symbol1 || (in_last &&
               ((symbol_count < 64 && (in_indices >> symbol_count) != 0) ||
                (last_symbol >> last_valid) != 0));
    always @(posedge clk) begin
        if(reset) begin
            stage_valid<=0; stage_last<=0; stage_bytes<=0; stage_data<=0;
            buffer<=0; used<=0; final_pending<=0; error<=0;
        end else begin
            if(pop) begin
                buffer<=shifted; used<=after_pop;
                if(out_last) final_pending<=0;
            end
            if(accept) begin
                buffer<=appended; used<=after_pop+stage_bytes;
                final_pending<=stage_last; stage_valid<=0;
            end
            if(take) begin
                if(bad) begin error<=1; stage_valid<=0; end
                else begin stage_valid<=1; stage_data<=expanded; stage_bytes<=in_bytes; stage_last<=in_last; end
            end
        end
    end
endmodule
